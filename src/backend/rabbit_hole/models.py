from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator


class ConversationTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=64000)


class AgentRequest(BaseModel):
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


class ToolSource(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    url: str
    title: str
    access: Literal["search_result", "page_read"]
    accessed_at: str
    verification: Literal["unverified"] = "unverified"
