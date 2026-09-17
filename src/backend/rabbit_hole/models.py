from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator


class ConversationTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=64000)


class NodeContext(BaseModel):
    model_config = ConfigDict(extra="forbid")
    node_id: str = Field(min_length=1, max_length=200)
    kind: Literal["information", "source"]
    title: str = Field(max_length=500)
    text: str = Field(min_length=1, max_length=12000)


class AgentRequest(BaseModel):
    node_context: NodeContext | None = None
    model_config = ConfigDict(extra="forbid")
    query: str = Field(min_length=1, max_length=2000)
    request_id: UUID
    continuation: str | None = Field(None, max_length=2_000_000)

    @field_validator("query")
    @classmethod
    def nonempty(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("메시지를 입력하세요.")
        return value.strip()


class Snapshot(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: Literal[2] = 2
    conversation: list[ConversationTurn] = Field(default_factory=list, max_length=24)
    issued_at: float


class TitleRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: UUID
    continuation: str = Field(min_length=1, max_length=2_000_000)


class TitleResponse(BaseModel):
    title: str = Field(min_length=1, max_length=60)


class SourceContent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: Literal["read", "failed", "skipped"]
    text: str = Field(default="", max_length=32000)
    truncated: bool = False
    final_url: str | None = None
    error_code: Literal["page_unavailable", "page_timeout", "budget_exhausted"] | None = None


class ToolSource(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    url: str
    title: str
    access: Literal["search_result", "page_read"]
    accessed_at: str
    verification: Literal["unverified"] = "unverified"
    content: SourceContent | None = None
