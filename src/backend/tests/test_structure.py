import asyncio
import json
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from rabbit_hole.agent import AgentService
from rabbit_hole.app import create_app
from rabbit_hole.config import Settings
from rabbit_hole.errors import StageFailure, error_code
from rabbit_hole.models import ConversationTurn, Snapshot
from rabbit_hole.security import SnapshotSigner
from rabbit_hole.structure import (
    ExtractSelection,
    ExtractSelections,
    numbered_lines,
    resolve_selections,
    text_hash,
)

TEXT = "🐇 원래 답변입니다.\n\n벡터 검색은 의미를 비교합니다. 단, 도메인에 따라 정확도가 달라집니다.\n\n" + "추가 설명을 그대로 보존합니다. " * 8
EXCERPT = "벡터 검색은 의미를 비교합니다. 단, 도메인에 따라 정확도가 달라집니다."


def candidates(start_line=3, end_line=3, title_line=3):
    return ExtractSelections(items=[ExtractSelection(
        subtype="concept", start_line=start_line, end_line=end_line, title_line=title_line)])


def test_extracts_are_exact_codepoint_spans_and_deterministic():
    first = resolve_selections(TEXT, candidates())
    item = first.items[0]
    assert item.excerpt.start == TEXT.index(EXCERPT)
    assert TEXT[item.excerpt.start:item.excerpt.end] == EXCERPT
    assert TEXT[item.title.start:item.title.end] == EXCERPT
    assert first == resolve_selections(TEXT, candidates())
    assert resolve_selections(TEXT, ExtractSelections(items=candidates().items * 2)) == first
    assert resolve_selections(TEXT, candidates(1, 5, 1)).items == []
    repeated = TEXT + "\n" + EXCERPT
    second = resolve_selections(repeated, candidates(6, 6, 6)).items[0]
    assert second.excerpt.start == repeated.rindex(EXCERPT)


@pytest.mark.parametrize("selection", [candidates(3, 99, 3), candidates(3, 3, 1), candidates(2, 2, 2)])
def test_invalid_line_selection_rejected(selection):
    with pytest.raises(StageFailure, match="structure_invalid_selection"):
        resolve_selections(TEXT, selection)


def test_markdown_and_unicode_are_copied_without_model_rewriting():
    text = "설명\r\n\r\n## 🐇 **개념**\r\n본문 [출처](https://example.com) 및 조건 유지.\r\n\r\n다른 내용"
    result = resolve_selections(text, candidates(3, 4, 3))
    item = result.items[0]
    assert item.title.quote == "🐇 **개념**"
    assert item.excerpt.quote == "## 🐇 **개념**\r\n본문 [출처](https://example.com) 및 조건 유지."
    assert text[item.excerpt.start:item.excerpt.end] == item.excerpt.quote
    assert text[item.title.start:item.title.end] == item.title.quote
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        ExtractSelections.model_validate({"items": [{"subtype": "concept", "title": "invented", "excerpt": "invented"}]})


async def test_structure_uses_no_tools_and_short_answers_need_no_call(monkeypatch):
    parse = AsyncMock(return_value=SimpleNamespace(status="completed", output_parsed=candidates()))
    client = SimpleNamespace(responses=SimpleNamespace(parse=parse), close=AsyncMock())
    monkeypatch.setattr("rabbit_hole.agent.AsyncOpenAI", lambda **kw: client)
    service = AgentService(Settings(_env_file=None, openai_api_key="fake"))
    assert (await service.structure("짧은 답변")).items == []
    parse.assert_not_called()
    assert (await service.structure(TEXT)).items[0].excerpt.quote == EXCERPT
    assert json.loads(parse.call_args.kwargs["input"]) == numbered_lines(TEXT)
    assert parse.call_args.kwargs["store"] is False and "tools" not in parse.call_args.kwargs
    parse.return_value = SimpleNamespace(status="completed", output_parsed=candidates(3, 99, 3))
    with pytest.raises(StageFailure, match="structure_invalid_selection"):
        await service.structure(TEXT)
    await service.close()


@pytest.mark.parametrize(("output", "code"), [
    (SimpleNamespace(status="incomplete", incomplete_details=SimpleNamespace(reason="max_output_tokens")), "structure_output_limit"),
    (SimpleNamespace(status="incomplete"), "structure_incomplete"),
    (SimpleNamespace(status="completed", output_parsed=None, output=[]), "structure_missing_output"),
    (SimpleNamespace(status="completed", output_parsed=None, output=[SimpleNamespace(content=[SimpleNamespace(type="refusal")])]), "structure_refused"),
])
async def test_structure_failures_have_safe_distinct_codes(monkeypatch, output, code):
    parse = AsyncMock(return_value=output)
    monkeypatch.setattr("rabbit_hole.agent.AsyncOpenAI", lambda **kw: SimpleNamespace(responses=SimpleNamespace(parse=parse)))
    with pytest.raises(StageFailure) as failure:
        await AgentService(Settings(_env_file=None, openai_api_key="fake")).structure(TEXT)
    assert error_code(failure.value) == code


def test_structure_contract_signed_text_and_failure_isolation():
    settings = Settings(_env_file=None, openai_api_key="fake", session_signing_key="x" * 32)
    signer = SnapshotSigner("x" * 32)
    token = signer.sign(Snapshot(issued_at=time.time(), conversation=[
        ConversationTurn(role="user", content="질문"), ConversationTurn(role="assistant", content=TEXT)]))

    class Service:
        calls = 0
        async def structure(self, text):
            Service.calls += 1
            return resolve_selections(text, candidates())
        async def close(self):
            pass

    client = TestClient(create_app(settings, lambda _: Service()))
    body = {"request_id": str(uuid4()), "continuation": token, "text_hash": text_hash(TEXT)}
    response = client.post("/api/structure", json=body)
    assert response.status_code == 200
    assert response.json() == resolve_selections(TEXT, candidates()).model_dump()
    assert client.post("/api/structure", json={**body, "continuation": "forged"}).status_code == 409
    assert client.post("/api/structure", json={**body, "text_hash": "a" * 64}).status_code == 409
    assert client.post("/api/structure", json={**body, "text": "injected"}).status_code == 422
    assert Service.calls == 1

    class Failure(Service):
        async def structure(self, text):
            raise RuntimeError("SECRET provider body")

    failed = TestClient(create_app(settings, lambda _: Failure())).post("/api/structure", json=body)
    assert failed.status_code == 502 and "SECRET" not in failed.text
    assert signer.verify(token).conversation[-1].content == TEXT


def test_structure_timeout_cancels_task_and_closes_client():
    settings = Settings(_env_file=None, openai_api_key="fake", session_signing_key="x" * 32, structure_timeout_seconds=1)
    token = SnapshotSigner("x" * 32).sign(Snapshot(issued_at=time.time(), conversation=[
        ConversationTurn(role="assistant", content=TEXT)]))
    state = {"cancelled": False, "closed": False}

    class Service:
        async def structure(self, text):
            try:
                await asyncio.Event().wait()
            finally:
                state["cancelled"] = True
        async def close(self):
            state["closed"] = True

    app = create_app(settings, lambda _: Service())
    response = TestClient(app).post("/api/structure", json={
        "request_id": str(uuid4()), "continuation": token, "text_hash": text_hash(TEXT)})
    assert response.status_code == 502 and all(state.values())
    assert all(job.finished for job in app.state.store.jobs.values())


async def test_real_sdk_parses_line_selection_without_copying_answer(monkeypatch):
    import httpx
    from openai import AsyncOpenAI

    def handler(request):
        payload = json.loads(request.content)
        assert json.loads(payload["input"])[2]["text"].strip() == EXCERPT
        assert payload["text"]["format"]["strict"] is True
        assert "tools" not in payload
        return httpx.Response(200, json={
            "id": "resp_test", "object": "response", "created_at": 0,
            "status": "completed", "model": "gpt-4.1-mini", "parallel_tool_calls": True,
            "tool_choice": "auto", "tools": [],
            "output": [{"id": "msg_test", "type": "message", "role": "assistant", "status": "completed",
                        "content": [{"type": "output_text", "text": candidates().model_dump_json(),
                                     "annotations": []}]}],
        })

    client = AsyncOpenAI(api_key="fake", http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    monkeypatch.setattr("rabbit_hole.agent.AsyncOpenAI", lambda **kw: client)
    service = AgentService(Settings(_env_file=None, openai_api_key="fake"))
    try:
        result = await service.structure(TEXT)
        assert result.items[0].excerpt.quote == EXCERPT
        assert result.text_hash == text_hash(TEXT)
    finally:
        await service.close()
