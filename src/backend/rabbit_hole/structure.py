"""Extract-only graph contract. Model text must resolve to exact public response spans."""

import hashlib
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from .errors import StageFailure

InformationKind = Literal["concept", "entity", "claim", "example", "comparison"]


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


class InformationExtract(StrictModel):
    key: str
    subtype: InformationKind
    title: TextSpan
    excerpt: TextSpan


class StructureResult(StrictModel):
    version: Literal[1] = 1
    text_hash: str
    items: list[InformationExtract]


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
