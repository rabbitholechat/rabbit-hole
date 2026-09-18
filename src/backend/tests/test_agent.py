from datetime import UTC, datetime
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


async def test_sdk_adapter_tools_only_public_text(monkeypatch):
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
    assert [t.name for t in service.agent.tools] == ["calculator", "web_search", "read_page", "image_search"]
    assert run.call_args.kwargs["run_config"].tracing_disabled
    assert run.call_args.kwargs["max_turns"] == 6
    result.cancel.assert_called_once()
    await service.close()
    client.close.assert_awaited_once()


async def test_request_date_refreshes_without_changing_conversation(monkeypatch):
    monkeypatch.setattr("rabbit_hole.agent.AsyncOpenAI", lambda **kw: SimpleNamespace(close=AsyncMock()))
    dates = iter(["\nCurrent date (UTC): 2040-12-31.\n", "\nCurrent date (UTC): 2041-01-01.\n"])
    monkeypatch.setattr("rabbit_hole.agent.current_date_context", lambda: next(dates))
    instructions = []

    def run(agent, **kwargs):
        instructions.append(agent.instructions)
        assert kwargs["input"] == [{"role": "user", "content": "What is current?"}]
        return StreamResult([
            event("response.output_text.delta", delta="answer"),
            event("response.completed", response=SimpleNamespace(status="completed")),
        ])

    monkeypatch.setattr("rabbit_hole.agent.Runner.run_streamed", run)
    service = AgentService(Settings(_env_file=None, openai_api_key="fake"))
    try:
        for _ in range(2):
            assert [s async for s in service.stream([ConversationTurn(role="user", content="What is current?")])] == ["answer"]
        assert "2040-12-31" in instructions[0]
        assert "2041-01-01" in instructions[1] and "2040-12-31" not in instructions[1]
    finally:
        await service.close()


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


@pytest.mark.parametrize("tool_case", ["none", "calculator", "web_search", "search_failure"])
async def test_real_sdk_with_mock_http_stream(monkeypatch, tool_case):
    """Exercise installed Agents + OpenAI SDK, without a paid/network request."""
    import json

    import httpx
    from openai import AsyncOpenAI

    monkeypatch.setattr("rabbit_hole.tools.AgentTools.image_search", AsyncMock(return_value={"sources": []}))
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
        if not captured[-1].get("stream"):
            assert tool_case in ("web_search", "search_failure")
            assert captured[-1]["tools"][0]["type"] == "web_search"
            if tool_case == "search_failure":
                return httpx.Response(503, json={"error": {"message": "PRIVATE provider failure"}})
            return httpx.Response(200, json={**response, "output": [
                {"id": "ws_test", "type": "web_search_call", "status": "completed",
                 "action": {"type": "search", "query": "current information", "sources": [
                     {"type": "url", "url": "https://example.com/current"}]}},
                message,
            ]})
        batch = wire_events
        if tool_case != "none" and len(captured) == 1:
            name = "calculator" if tool_case == "calculator" else "web_search"
            arguments = '{"expression":"0.1 + 0.2"}' if name == "calculator" else '{"query":"current information"}'
            call = {"id": "fc_test", "type": "function_call", "call_id": "call_calc",
                    "name": name, "arguments": arguments, "status": "completed"}
            batch = [
                {"type": "response.created", "sequence_number": 0,
                 "response": {**response, "status": "in_progress", "output": []}},
                {"type": "response.output_item.added", "sequence_number": 1, "output_index": 0,
                 "item": {**call, "arguments": "", "status": "in_progress"}},
                {"type": "response.function_call_arguments.delta", "sequence_number": 2,
                 "item_id": "fc_test", "output_index": 0, "delta": call["arguments"]},
                {"type": "response.function_call_arguments.done", "sequence_number": 3,
                 "item_id": "fc_test", "output_index": 0, "arguments": call["arguments"]},
                {"type": "response.output_item.done", "sequence_number": 4, "output_index": 0, "item": call},
                {"type": "response.completed", "sequence_number": 5,
                 "response": {**response, "output": [call]}},
            ]
        payload = "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in batch)
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
        main_calls = [c for c in captured if c.get("stream")]
        assert len(main_calls) == (1 if tool_case == "none" else 2)
        assert len(captured) == {"none": 1, "calculator": 2, "web_search": 3, "search_failure": 3}[tool_case]
        today = datetime.now(UTC).date().isoformat()
        for call in captured:
            instructions = call.get("instructions") or str(call["input"])
            assert f"Current date (UTC): {today}" in instructions
        if tool_case != "none":
            output = next(i for i in main_calls[1]["input"] if i.get("type") == "function_call_output")
            assert output["call_id"] == "call_calc"
            expected = {"calculator": "0.3", "web_search": "https://example.com/current",
                        "search_failure": "tool_failed"}[tool_case]
            assert expected in str(output["output"])
            assert "PRIVATE" not in str(output["output"])
        if tool_case == "web_search":
            assert "Absence from one result set is not evidence of absence" in main_calls[0]["instructions"]
            search_call = next(c for c in captured if not c.get("stream"))
            assert search_call["tools"][0]["search_context_size"] == "medium"
            assert "publication/event dates" in search_call["instructions"]
            assert "not-announced/nonexistent/rumor-only" in search_call["instructions"]
            assert json.loads(search_call["input"]) == {"query": "current information", "user_request": "안녕"}
            assert "Preserve user-specified names and identifiers exactly" in main_calls[0]["instructions"]
            assert "remaining_searches" in output["output"]
            assert service.sources[0].url == "https://example.com/current"
        elif tool_case == "search_failure":
            assert service.sources == []
        assert captured[0]["stream"] is True
        assert captured[0]["store"] is False
        assert [t["name"] for t in captured[0]["tools"]] == ["calculator", "web_search", "read_page", "image_search"]
        assert captured[0]["parallel_tool_calls"] is False
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
