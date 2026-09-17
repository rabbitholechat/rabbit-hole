from functools import lru_cache
from pathlib import Path

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=Path(__file__).parents[1] / ".env", extra="ignore")
    database_url: SecretStr = SecretStr("")
    max_history_bytes: int = Field(4_000_000, ge=10000, le=4_000_000)
    openai_api_key: SecretStr = SecretStr("")
    debug_diagnostics: bool = False
    openai_model: str = "gpt-4.1-mini"
    openai_background_model: str = "gpt-4o-mini"
    openai_search_model: str = "gpt-4.1-mini"
    openai_structure_model: str = "gpt-4.1-mini"
    structure_timeout_seconds: float = Field(25, ge=1, le=60)
    background_timeout_seconds: float = Field(15, ge=1, le=60)
    job_timeout_seconds: float = Field(90, ge=1, le=300)
    request_timeout_seconds: float = Field(20, ge=1, le=60)
    max_context_turns: int = Field(12, ge=4, le=24)
    max_model_turns: int = Field(6, ge=1, le=20)
    max_tool_calls: int = Field(8, ge=1, le=20)
    openai_source_summary_model: str = "gpt-4.1-mini"
    max_source_summaries: int = Field(5, ge=0, le=50)
    source_summary_timeout_seconds: float = Field(15, ge=1, le=60)
    max_source_concurrency: int = Field(3, ge=1, le=8)
    max_response_sources: int = Field(5, ge=1, le=50)
    max_image_searches: int = Field(1, ge=0, le=5)
    max_web_searches: int = Field(2, ge=1, le=5)
    tool_timeout_seconds: float = Field(20, ge=1, le=60)
    max_page_bytes: int = Field(1_000_000, ge=1024, le=2_000_000)
    max_page_decoded_bytes: int = Field(4_000_000, ge=1024, le=8_000_000)
    max_page_chars: int = Field(16_000, ge=100, le=32_000)
    max_output_tokens: int = Field(4000, ge=256, le=16000)
    max_request_bytes: int = Field(2_100_000, ge=10000, le=4_000_000)
    max_concurrent_jobs: int = Field(4, ge=1, le=32)
    requests_per_minute: int = Field(10, ge=1, le=100)
    job_ttl_seconds: int = Field(1800, ge=60)
    max_stored_jobs: int = Field(100, ge=1, le=1000)
    session_signing_key: SecretStr = SecretStr("")
    backend_host: str = "127.0.0.1"
    backend_port: int = 8018
    frontend_port: int = 5178

    @property
    def configured(self) -> bool:
        return bool(self.openai_api_key.get_secret_value())


@lru_cache
def get_settings() -> Settings:
    return Settings()
