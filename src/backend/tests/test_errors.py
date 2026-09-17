import httpx
import pytest
from openai import APIError, BadRequestError

from rabbit_hole.errors import provider_diagnostics


def test_provider_status_and_setting_are_logged_without_body():
    response = httpx.Response(400, request=httpx.Request("POST", "https://api.openai.com/v1/responses"))
    error = BadRequestError("SECRET", response=response, body={
        "code": "unsupported_parameter", "type": "invalid_request_error",
        "param": "temperature", "message": "SECRET", "input": "PRIVATE",
    })
    assert provider_diagnostics(error) == {"provider": {
        "code": "unsupported_parameter", "type": "invalid_request_error",
        "param": "temperature", "http_status": 400,
    }}


@pytest.mark.parametrize("body", [None, "SECRET", {"error": {
    "code": "server_error", "type": "server_error", "message": "SECRET",
}}])
def test_stream_errors_have_no_invented_http_status(body):
    error = APIError("SECRET", request=httpx.Request("POST", "https://api.openai.com/v1/responses"), body=body)
    assert provider_diagnostics(error) == {"provider": {
        "code": "server_error" if isinstance(body, dict) else None,
        "type": "server_error" if isinstance(body, dict) else None,
        "param": None, "http_status": None,
    }}


@pytest.mark.parametrize("value", ["SECRET", "sk-private-key", "user input", {"secret": "PRIVATE"}, ["PRIVATE"]])
def test_unknown_provider_metadata_is_redacted(value):
    error = APIError("SECRET", request=httpx.Request("POST", "https://api.openai.com/v1/responses"), body=None)
    error.body = {"code": value, "type": value, "param": value}
    assert provider_diagnostics(error) == {"provider": {
        "code": "redacted", "type": "redacted", "param": "redacted", "http_status": None,
    }}
    assert provider_diagnostics(ValueError("SECRET")) == {}
