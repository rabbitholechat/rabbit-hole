"""Answer-grounded cards with field-level references to public response spans."""

import hashlib
from typing import Generic, Literal, TypeVar
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .errors import StageFailure

InformationKind = Literal["concept", "entity", "claim", "example", "comparison", "procedure"]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class StructureRequest(StrictModel):
    request_id: UUID
    continuation: str = Field(min_length=1, max_length=2_000_000)
    text_hash: str = Field(pattern=r"^[a-f0-9]{64}$")


class ExtractSelection(StrictModel):
    subtype: InformationKind
    start_line: int = Field(ge=1)
    end_line: int = Field(ge=1)
    title_line: int = Field(ge=1)


class ExtractSelections(StrictModel):
    items: list[ExtractSelection] = Field(max_length=6)


class TextSpan(StrictModel):
    start: int = Field(ge=0)
    end: int = Field(gt=0)
    quote: str


Reference = TypeVar("Reference")


class LineRange(StrictModel):
    start_line: int = Field(ge=1)
    end_line: int = Field(ge=1)


class GroundedText(StrictModel, Generic[Reference]):
    text: str = Field(min_length=1, max_length=800)
    references: list[Reference] = Field(min_length=1, max_length=4)


class CardSection(StrictModel, Generic[Reference]):
    heading: str | None = Field(max_length=80)
    layout: Literal["text", "bullets", "steps"]
    items: list[GroundedText[Reference]] = Field(min_length=1, max_length=8)


class CardTable(StrictModel, Generic[Reference]):
    columns: list[GroundedText[Reference]] = Field(min_length=2, max_length=5)
    rows: list[list[GroundedText[Reference] | None]] = Field(min_length=1, max_length=8)

    @model_validator(mode="after")
    def rectangular(self):
        if any(len(row) != len(self.columns) or not any(row) for row in self.rows):
            raise ValueError("invalid_table")
        return self


class CardPresentation(StrictModel, Generic[Reference]):
    heading: str = Field(min_length=1, max_length=100)
    summary: GroundedText[Reference] | None
    sections: list[CardSection[Reference]] = Field(max_length=4)
    table: CardTable[Reference] | None

    @model_validator(mode="after")
    def useful_content(self):
        values = presentation_values(self)
        if not values or any(not v.text.strip() for v in values) or not self.heading.strip():
            raise ValueError("empty_card")
        if any(section.heading is not None and not section.heading.strip() for section in self.sections):
            raise ValueError("empty_heading")
        size = len(self.heading) + sum(len(v.text) for v in values)
        size += sum(len(section.heading or "") for section in self.sections)
        if size > 6000:
            raise ValueError("card_too_large")
        return self


def presentation_values(card):
    values = [card.summary] if card.summary else []
    values += [item for section in card.sections for item in section.items]
    if card.table:
        values += card.table.columns
        values += [cell for row in card.table.rows for cell in row if cell is not None]
    return values


class CardSelection(StrictModel):
    subtype: InformationKind
    presentation: CardPresentation[LineRange]


class CardSelections(StrictModel):
    items: list[CardSelection] = Field(max_length=6)


class InformationExtract(StrictModel):
    key: str
    subtype: InformationKind
    # Legacy-compatible original anchors; v2 display uses presentation instead.
    title: TextSpan
    excerpt: TextSpan
    presentation: CardPresentation[TextSpan] | None = None


class StructureResult(StrictModel):
    version: Literal[1, 2] = 1
    text_hash: str
    items: list[InformationExtract] = Field(max_length=6)

    @model_validator(mode="after")
    def versioned_cards(self):
        if any((item.presentation is not None) != (self.version == 2) for item in self.items):
            raise ValueError("invalid_card_version")
        return self


def text_hash(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def numbered_lines(text: str) -> list[dict]:
    return [{"line": i, "text": line} for i, line in enumerate(text.splitlines(keepends=True), 1)]


def resolve_selections(text: str, selections: ExtractSelections) -> StructureResult:
    lines = text.splitlines(keepends=True)
    offsets = [0]
    for line in lines:
        offsets.append(offsets[-1] + len(line))
    digest = text_hash(text)
    items = []
    seen = set()
    for item in selections.items:
        if not 1 <= item.start_line <= item.title_line <= item.end_line <= len(lines):
            raise StageFailure("structure", "structure_invalid_selection")
        start, end = offsets[item.start_line - 1], offsets[item.end_line]
        # Trim only boundary whitespace; all contents are copied by the server.
        raw = text[start:end]
        start += len(raw) - len(raw.lstrip())
        end -= len(raw) - len(raw.rstrip())
        excerpt = text[start:end]
        title_line = lines[item.title_line - 1]
        title = title_line.strip().lstrip("#>*- ").strip()[:100].rstrip()
        if not excerpt or not title or len(excerpt) > 6000:
            raise StageFailure("structure", "structure_invalid_selection")
        title_start = offsets[item.title_line - 1] + title_line.index(title)
        if not start <= title_start < title_start + len(title) <= end:
            raise StageFailure("structure", "structure_invalid_selection")
        if excerpt == text.strip() or excerpt in seen:
            continue
        seen.add(excerpt)
        key = text_hash(f"{digest}:{start}:{end}:{item.subtype}")[:24]
        items.append(InformationExtract(
            key=key, subtype=item.subtype,
            title=TextSpan(start=title_start, end=title_start + len(title), quote=title),
            excerpt=TextSpan(start=start, end=end, quote=excerpt),
        ))
    return StructureResult(text_hash=digest, items=sorted(items, key=lambda item: item.excerpt.start))


def resolve_cards(text: str, selections: CardSelections) -> StructureResult:
    lines = text.splitlines(keepends=True)
    offsets = [0]
    for line in lines:
        offsets.append(offsets[-1] + len(line))

    def resolve(value):
        if isinstance(value, list):
            return [resolve(item) for item in value]
        if not isinstance(value, dict):
            return value
        if set(value) == {"start_line", "end_line"}:
            first, last = value["start_line"], value["end_line"]
            if not 1 <= first <= last <= len(lines):
                raise StageFailure("structure", "structure_invalid_selection")
            start, end = offsets[first - 1], offsets[last]
            raw = text[start:end]
            start += len(raw) - len(raw.lstrip())
            end -= len(raw) - len(raw.rstrip())
            if start >= end or end - start > 6000:
                raise StageFailure("structure", "structure_invalid_selection")
            return TextSpan(start=start, end=end, quote=text[start:end]).model_dump()
        return {key: resolve(item) for key, item in value.items()}

    digest = text_hash(text)
    items, seen = [], set()
    for selection in selections.items:
        card = CardPresentation[TextSpan].model_validate(resolve(selection.presentation.model_dump()))
        identity = f"{selection.subtype}:{card.model_dump_json()}"
        if identity in seen:
            continue
        seen.add(identity)
        spans = [ref for value in presentation_values(card) for ref in value.references]
        anchor = min(spans, key=lambda span: (span.start, span.end))
        title = TextSpan(start=anchor.start, end=min(anchor.start + 100, anchor.end), quote=anchor.quote[:100])
        items.append(InformationExtract(
            key=text_hash(f"{digest}:{identity}")[:24], subtype=selection.subtype,
            title=title, excerpt=anchor, presentation=card,
        ))
    return StructureResult(version=2, text_hash=digest, items=items)
