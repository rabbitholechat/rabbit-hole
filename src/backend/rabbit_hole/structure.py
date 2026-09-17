"""Extract-only graph contract. Model text must resolve to exact public response spans."""

import hashlib
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

InformationKind = Literal["concept", "entity", "claim", "example", "comparison"]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class StructureRequest(StrictModel):
    request_id: UUID
    continuation: str = Field(min_length=1, max_length=2_000_000)
    text_hash: str = Field(pattern=r"^[a-f0-9]{64}$")


class ExtractCandidate(StrictModel):
    subtype: InformationKind
    title: str = Field(min_length=1, max_length=100)
    excerpt: str = Field(min_length=1, max_length=6000)


class ExtractCandidates(StrictModel):
    items: list[ExtractCandidate] = Field(max_length=6)


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


def validate_extracts(text: str, candidates: ExtractCandidates) -> StructureResult:
    digest = text_hash(text)
    items = []
    seen = set()
    for item in candidates.items:
        start = text.find(item.excerpt)
        title_start = item.excerpt.find(item.title)
        # Ambiguous excerpts cannot be assigned a trustworthy location.
        if start < 0 or title_start < 0 or text.count(item.excerpt) != 1:
            raise ValueError("invalid_extract")
        if item.excerpt.strip() == text.strip() or item.excerpt in seen:
            continue
        seen.add(item.excerpt)
        end = start + len(item.excerpt)
        key = text_hash(f"{digest}:{start}:{end}:{item.subtype}")[:24]
        items.append(InformationExtract(
            key=key, subtype=item.subtype,
            title=TextSpan(start=start + title_start, end=start + title_start + len(item.title), quote=item.title),
            excerpt=TextSpan(start=start, end=end, quote=item.excerpt),
        ))
    return StructureResult(text_hash=digest, items=sorted(items, key=lambda item: item.excerpt.start))
