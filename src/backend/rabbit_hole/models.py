from datetime import datetime
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
    content_origin: Literal["search_snippet", "web_search_summary"] = "search_snippet"
    excerpt: str = ""
    published_at: str | None = None
    retrieved_at: str
    read_status: Literal["summary", "read", "failed"] = "summary"
    tag: str = "웹페이지"


class Evidence(BaseModel):
    source_id: str
    quote: str
    basis: Literal["summary", "excerpt"]


class Claim(BaseModel):
    text: str
    evidence: list[Evidence]


class Answer(BaseModel):
    claims: list[Claim]
    limitation: str


class Relation(BaseModel):
    source: str
    target: str
    kind: Literal[
        "same_topic",
        "comparison",
        "application",
        "same_entity",
        "same_conditions",
        "contrasting_view",
        "related_concept",
    ]
    label: str
    explanation: str
    evidence: list[Evidence]
    strength: Literal["core", "weak"]


class Cluster(BaseModel):
    id: str
    label: str
    source_ids: list[str]


class PageType(BaseModel):
    source_id: str
    tag: Literal[
        "공식 문서", "기사", "블로그", "비교", "구현 가이드", "웹페이지", "루머·예상", "예약·가격 비교"
    ]


class Relationships(BaseModel):
    page_types: list[PageType] = Field(default_factory=list)
    relations: list[Relation]
    clusters: list[Cluster]


class Verification(BaseModel):
    supported_claim_indices: list[int]


class Clarification(BaseModel):
    message: str = Field(min_length=1, max_length=500)
    questions: list[str] = Field(min_length=1, max_length=3)
    suggestions: list[str] = Field(max_length=4)

    @model_validator(mode="after")
    def bounded_text(self):
        if any(not text.strip() or len(text) > 500 for text in self.questions + self.suggestions):
            raise ValueError("Clarification text must be nonempty and bounded")
        return self


class SearchPlan(BaseModel):
    action: Literal["search", "clarify"]
    query: str = Field(max_length=2000)
    clarification: Clarification | None

    @model_validator(mode="after")
    def consistent_action(self):
        if self.action == "search" and (not self.query.strip() or self.clarification is not None):
            raise ValueError("Search requires a query and no clarification")
        if self.action == "clarify" and self.clarification is None:
            raise ValueError("Clarify requires questions")
        return self


class ConversationTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=4000)


class SearchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    query: str = Field(min_length=1, max_length=2000)
    request_id: UUID
    continuation: str | None = Field(None, max_length=2_000_000)
    focus_source_id: str | None = Field(None, max_length=80)
    retry_part: Literal["intent", "answer", "relationships"] | None = None

    @model_validator(mode="after")
    def nonempty(self):
        self.query = self.query.strip()
        if not self.query:
            raise ValueError("질문을 입력하세요.")
        if (self.focus_source_id or self.retry_part) and not self.continuation:
            raise ValueError("기존 검색 정보가 필요합니다.")
        return self


class Snapshot(BaseModel):
    query: str
    sources: list[Source]
    answer: Answer | None = None
    relationships: Relationships | None = None
    conversation: list[ConversationTurn] = Field(default_factory=list, max_length=24)
    clarification: Clarification | None = None
    search_query: str = ""
    issued_at: float
    mode: Literal["live"] = "live"


def utc_now() -> str:
    from datetime import UTC

    return datetime.now(UTC).isoformat()
