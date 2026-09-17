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
