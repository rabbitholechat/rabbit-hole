from functools import lru_cache
from pathlib import Path

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=Path(__file__).parents[1] / '.env', extra='ignore')
    openai_api_key: SecretStr = SecretStr('')
    tavily_api_key: SecretStr = SecretStr('')
    openai_model: str = 'gpt-4.1-mini'
    max_search_calls: int = Field(3, ge=1, le=10)
    max_sources: int = Field(10, ge=1, le=20)
    max_extract_sources: int = Field(5, ge=0, le=10)
    job_timeout_seconds: float = Field(90, ge=1, le=300)
    request_timeout_seconds: float = Field(20, ge=1, le=60)
    external_retries: int = Field(1, ge=0, le=2)
    max_model_turns: int = Field(8, ge=1, le=20)
    max_output_tokens: int = Field(4000, ge=256, le=16000)
    max_concurrent_jobs: int = Field(4, ge=1, le=32)
    requests_per_minute: int = Field(10, ge=1, le=100)
    job_ttl_seconds: int = Field(1800, ge=60)
    max_stored_jobs: int = Field(100, ge=1, le=1000)
    session_signing_key: SecretStr = SecretStr('')
    backend_host: str = '127.0.0.1'
    backend_port: int = 8018
    frontend_port: int = 5178

    @property
    def configured(self) -> bool:
        return bool(self.openai_api_key.get_secret_value() and self.tavily_api_key.get_secret_value())


@lru_cache
def get_settings() -> Settings:
    return Settings()
