"""Allowlisted diagnostics only: never expose provider messages, bodies or prompts."""

from pathlib import Path

from agents.exceptions import MaxTurnsExceeded, ModelBehaviorError
from openai import APIConnectionError, APIError, APIStatusError, APITimeoutError
from pydantic import ValidationError


class StageFailure(ValueError):
    def __init__(self, part: str, code: str):
        self.part = part
        self.code = code
        super().__init__(code)


_PROVIDER_CODES = frozenset({
    "server_error", "internal_error", "server_is_overloaded", "service_unavailable",
    "rate_limit_exceeded", "insufficient_quota", "billing_hard_limit_reached",
    "credit_balance_exhausted", "organization_spend_limit_exceeded",
    "project_spend_limit_exceeded", "organization_usage_limit_exceeded",
    "invalid_api_key", "invalid_organization", "organization_deactivated",
    "permission_denied", "model_not_found", "model_not_available",
    "unsupported_parameter", "unsupported_value", "invalid_parameter", "invalid_value",
    "missing_required_parameter", "context_length_exceeded", "invalid_request_error",
    "content_policy_violation", "content_filter", "request_timeout", "timeout",
    "response_failed", "response_incomplete", "tool_error", "invalid_tool_output",
})
_PROVIDER_TYPES = frozenset({
    "server_error", "internal_error", "invalid_request_error", "rate_limit_error",
    "insufficient_quota", "authentication_error", "permission_error", "api_error",
    "not_found_error", "requests", "tokens",
})
_PROVIDER_PARAMS = frozenset({
    "model", "input", "instructions", "tools", "tool_choice", "parallel_tool_calls",
    "max_output_tokens", "temperature", "top_p", "reasoning", "reasoning.effort",
    "text", "text.format", "text.verbosity", "stream", "store", "previous_response_id",
    "include", "service_tier", "truncation",
})


def provider_diagnostics(error: Exception) -> dict:
    """Only known provider metadata; never serialize arbitrary response fields."""
    if not isinstance(error, APIError):
        return {}
    body = error.body if isinstance(error.body, dict) else {}
    if isinstance(body.get("error"), dict):
        body = body["error"]

    def allowed(name: str, choices: frozenset[str]) -> str | None:
        value = getattr(error, name, None)
        if value is None:
            value = body.get(name)
        if value is None:
            return None
        return value if isinstance(value, str) and value in choices else "redacted"

    status = getattr(error, "status_code", None)
    return {"provider": {
        "code": allowed("code", _PROVIDER_CODES),
        "type": allowed("type", _PROVIDER_TYPES),
        "param": allowed("param", _PROVIDER_PARAMS),
        # SSE errors do not carry an HTTP failure status; do not invent 500.
        "http_status": status if type(status) is int and 100 <= status <= 599 else None,
    }}


def error_code(error: Exception) -> str:
    if isinstance(error, StageFailure):
        return error.code
    if isinstance(error, (TimeoutError, APITimeoutError)):
        return "timeout"
    if isinstance(error, (ConnectionError, APIConnectionError)):
        return "connection_error"
    if isinstance(error, APIStatusError):
        if error.status_code in {401, 403}:
            return "provider_auth_error"
        if error.status_code == 429:
            return "provider_rate_limit"
        if error.status_code in {400, 404, 422}:
            return "provider_request_error"
        return "provider_error"
    # A successful HTTP connection can still carry an SSE error. The SDK raises
    # plain APIError for that case, without an HTTP status code.
    if isinstance(error, APIError):
        return "provider_error"
    if isinstance(error, MaxTurnsExceeded):
        return "turn_limit"
    if isinstance(error, (ModelBehaviorError, ValidationError, ValueError)):
        return "invalid_output"
    return "internal_error"


MESSAGES = {
    "required_tool_not_used": "선택한 도구가 실행되지 않아 응답을 완료하지 못했습니다. 다시 시도해 주세요.",
    "timeout": "응답 시간이 초과되었습니다.",
    "connection_error": "모델 서비스에 연결하지 못했습니다.",
    "provider_auth_error": "모델 서비스의 API 키 또는 접근 권한을 확인하세요.",
    "provider_rate_limit": "모델 서비스의 요청 한도 또는 사용 가능 잔액을 확인하세요.",
    "provider_request_error": "모델 서비스가 요청을 거부했습니다. 모델과 도구 설정을 확인하세요.",
    "provider_error": "모델 서비스에서 응답을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.",
    "invalid_output": "모델의 응답을 확인하지 못했습니다.",
    "turn_limit": "모델 실행 횟수 한도에 도달했습니다.",
    "incomplete_response": "모델 응답이 완료되지 않았습니다. 받은 내용은 보존했습니다.",
    "output_limit": "응답 길이 한도에 도달했습니다. 받은 내용은 보존했습니다.",
    "internal_error": "작업 처리 중 오류가 발생했습니다.",
}


def error_location(error: Exception) -> str:
    """Stack metadata only; exclude source lines, locals and exception messages."""
    frames = []
    tb = error.__traceback__
    while tb is not None:
        code = tb.tb_frame.f_code
        frames.append(f"{Path(code.co_filename).name}:{tb.tb_lineno}:{code.co_name}")
        tb = tb.tb_next
    return " > ".join(frames[-6:]) or "unavailable"
