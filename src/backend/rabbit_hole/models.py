from datetime import date, datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator


class Source(BaseModel):
    id: str
    original_url: str
    url: str
    title: str
    domain: str
    summary: str
    excerpt: str = ''
    published_at: str | None = None
    retrieved_at: str
    read_status: Literal['summary', 'read', 'failed'] = 'summary'
    tag: str = '웹페이지'


class Evidence(BaseModel):
    source_id: str
    quote: str
    basis: Literal['summary', 'excerpt']


class Claim(BaseModel):
    text: str
    evidence: list[Evidence]


class Answer(BaseModel):
    claims: list[Claim]
    limitation: str


class Relation(BaseModel):
    source: str
    target: str
    kind: Literal['same_topic', 'comparison', 'application', 'same_entity', 'same_conditions',
                  'contrasting_view', 'related_concept']
    label: str
    explanation: str
    evidence: list[Evidence]
    strength: Literal['core', 'weak']


class Cluster(BaseModel):
    id: str
    label: str
    source_ids: list[str]


class Relationships(BaseModel):
    relations: list[Relation]
    clusters: list[Cluster]


class Verification(BaseModel):
    supported_claim_indices: list[int]


class Flight(BaseModel):
    origin: str = Field(min_length=2, max_length=100)
    departure: date
    return_date: date | None = None
    trip: Literal['one_way', 'round_trip']
    passengers: int = Field(ge=1, le=9)
    direct: bool
    baggage: Literal['none', 'cabin', 'checked']

    @model_validator(mode='after')
    def dates(self):
        if self.departure < date.today():
            raise ValueError('출발일은 오늘 이후여야 합니다.')
        if self.trip == 'round_trip' and (not self.return_date or self.return_date < self.departure):
            raise ValueError('왕복 귀국일을 확인하세요.')
        return self


class SearchRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    query: str = Field(min_length=1, max_length=2000)
    request_id: UUID
    continuation: str | None = Field(None, max_length=500_000)
    focus_source_id: str | None = Field(None, max_length=80)
    retry_part: Literal['answer', 'relationships'] | None = None
    flight: Flight | None = None

    @model_validator(mode='after')
    def nonempty(self):
        self.query = self.query.strip()
        if not self.query:
            raise ValueError('질문을 입력하세요.')
        if (self.focus_source_id or self.retry_part) and not self.continuation:
            raise ValueError('기존 검색 정보가 필요합니다.')
        return self


class Snapshot(BaseModel):
    query: str
    sources: list[Source]
    answer: Answer | None = None
    relationships: Relationships | None = None
    flight: Flight | None = None
    issued_at: float
    mode: Literal['live'] = 'live'


def utc_now() -> str:
    from datetime import UTC
    return datetime.now(UTC).isoformat()
