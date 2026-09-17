from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from rabbit_hole.agent import AgentService
from rabbit_hole.config import Settings
from rabbit_hole.errors import StageFailure
from rabbit_hole.models import ConversationTurn


def event(kind, **data):
    return SimpleNamespace(type="raw_response_event", data=SimpleNamespace(type=kind, **data))


class StreamResult:
    def __init__(self, events):
        self.events = events
        self.cancel = Mock()

    async def stream_events(self):
        while self.events:
            yield self.events.pop(0)


async def test_sdk_adapter_no_tools_only_public_text(monkeypatch):
    client = SimpleNamespace(close=AsyncMock())
    monkeypatch.setattr("rabbit_hole.agent.AsyncOpenAI", lambda **kw: client)
    result = StreamResult(
        [
            event("response.reasoning_summary_text.delta", delta="SECRET"),
            event("response.output_text.delta", delta="**답변**"),
            event("response.refusal.delta", delta=" 거절 설명"),
            event("response.completed", response=SimpleNamespace(status="completed")),
        ]
    )
    run = Mock(return_value=result)
    monkeypatch.setattr("rabbit_hole.agent.Runner.run_streamed", run)
    service = AgentService(Settings(_env_file=None, openai_api_key="fake"))
    assert [text async for text in service.stream([ConversationTurn(role="user", content="hello")])] == [
        "**답변**",
        " 거절 설명",
    ]
    assert service.agent.tools == []
    assert run.call_args.kwargs["run_config"].tracing_disabled
    assert run.call_args.kwargs["max_turns"] == 1
    result.cancel.assert_called_once()
    await service.close()
    client.close.assert_awaited_once()


async def test_sdk_incomplete_response_and_generator_close_cancel_runner(monkeypatch):
    monkeypatch.setattr("rabbit_hole.agent.AsyncOpenAI", lambda **kw: SimpleNamespace(close=AsyncMock()))
    result = StreamResult(
        [event("response.output_text.delta", delta="partial"), event("response.incomplete")]
    )
    monkeypatch.setattr("rabbit_hole.agent.Runner.run_streamed", Mock(return_value=result))
    service = AgentService(Settings(_env_file=None, openai_api_key="fake"))
    with pytest.raises(StageFailure, match="incomplete_response"):
        _ = [text async for text in service.stream([])]
    result.cancel.assert_called_once()
    result = StreamResult([event("response.output_text.delta", delta="first")])
    monkeypatch.setattr("rabbit_hole.agent.Runner.run_streamed", Mock(return_value=result))
    stream = service.stream([])
    assert await anext(stream) == "first"
    await stream.aclose()
    result.cancel.assert_called_once()


async def test_real_sdk_with_mock_http_stream(monkeypatch):
    """Exercise installed Agents + OpenAI SDK, without a paid/network request."""
    import json

    import httpx
    from openai import AsyncOpenAI

    captured = []
    message = {
        "id": "msg_test",
        "type": "message",
        "role": "assistant",
        "status": "completed",
        "content": [{"type": "output_text", "text": "**응답**", "annotations": []}],
    }
    response = {
        "id": "resp_test",
        "object": "response",
        "created_at": 1,
        "status": "completed",
        "model": "gpt-4.1-mini",
        "output": [message],
        "tool_choice": "auto",
        "tools": [],
        "parallel_tool_calls": False,
        "error": None,
        "incomplete_details": None,
        "usage": {
            "input_tokens": 10,
            "output_tokens": 5,
            "total_tokens": 15,
            "input_tokens_details": {"cached_tokens": 0},
            "output_tokens_details": {"reasoning_tokens": 0},
        },
    }
    wire_events = [
        {
            "type": "response.created",
            "sequence_number": 0,
            "response": {**response, "status": "in_progress", "output": []},
        },
        {
            "type": "response.output_text.delta",
            "sequence_number": 1,
            "item_id": "msg_test",
            "output_index": 0,
            "content_index": 0,
            "delta": "**응답**",
            "logprobs": [],
        },
        {"type": "response.completed", "sequence_number": 2, "response": response},
    ]

    async def transport(request):
        captured.append(json.loads(request.content))
        payload = "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in wire_events)
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=payload)

    client = AsyncOpenAI(
        api_key="test-only",
        max_retries=0,
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(transport)),
    )
    monkeypatch.setattr("rabbit_hole.agent.AsyncOpenAI", lambda **kw: client)
    service = AgentService(Settings(_env_file=None, openai_api_key="test-only"))
    try:
        assert [delta async for delta in service.stream([ConversationTurn(role="user", content="안녕")])] == [
            "**응답**"
        ]
        assert len(captured) == 1
        assert captured[0]["stream"] is True
        assert captured[0]["store"] is False
        assert captured[0].get("tools", []) == []
        assert captured[0]["max_output_tokens"] == 4000
    finally:
        await service.close()


async def test_real_sdk_cancellation_reaches_pending_http_request(monkeypatch):
    import asyncio

    import httpx
    from openai import AsyncOpenAI

    started, cancelled = asyncio.Event(), asyncio.Event()

    async def transport(request):
        started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancelled.set()
            raise

    client = AsyncOpenAI(
        api_key="test-only",
        max_retries=0,
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(transport)),
    )
    monkeypatch.setattr("rabbit_hole.agent.AsyncOpenAI", lambda **kw: client)
    service = AgentService(Settings(_env_file=None, openai_api_key="test-only"))
    stream = service.stream([ConversationTurn(role="user", content="hello")])
    task = asyncio.create_task(anext(stream))
    try:
        await asyncio.wait_for(started.wait(), 2)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        await asyncio.wait_for(cancelled.wait(), 2)
    finally:
        await stream.aclose()
        await service.close()


async def test_title_uses_independent_model_and_rejects_incomplete_output(monkeypatch):
    create = AsyncMock(return_value=SimpleNamespace(status="completed", output_text=" 인사 나누기 "))
    client = SimpleNamespace(responses=SimpleNamespace(create=create), close=AsyncMock())
    monkeypatch.setattr("rabbit_hole.agent.AsyncOpenAI", lambda **kw: client)
    service = AgentService(Settings(_env_file=None, openai_api_key="fake", openai_background_model="title-model"))
    turns = [ConversationTurn(role="user", content="안녕"), ConversationTurn(role="assistant", content="반가워요")]
    assert await service.title(turns) == "인사 나누기"
    assert create.call_args.kwargs["model"] == "title-model"
    assert create.call_args.kwargs["store"] is False
    assert "tools" not in create.call_args.kwargs
    create.return_value = SimpleNamespace(status="incomplete", output_text="partial")
    with pytest.raises(StageFailure):
        await service.title(turns)
    await service.close()
