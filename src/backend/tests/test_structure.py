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
    CardSelections,
    ExtractSelection,
    ExtractSelections,
    numbered_lines,
    resolve_cards,
    resolve_selections,
    text_hash,
)

TEXT = "🐇 원래 답변입니다.\n\n벡터 검색은 의미를 비교합니다. 단, 도메인에 따라 정확도가 달라집니다.\n\n" + "추가 설명을 그대로 보존합니다. " * 8
EXCERPT = "벡터 검색은 의미를 비교합니다. 단, 도메인에 따라 정확도가 달라집니다."


def candidates(start_line=3, end_line=3, title_line=3):
    return ExtractSelections(items=[ExtractSelection(
        subtype="concept", start_line=start_line, end_line=end_line, title_line=title_line)])


def cards(start_line=3, end_line=3):
    return CardSelections.model_validate({"items": [{"subtype": "concept", "presentation": {
        "heading": "벡터 검색을 이해하는 방법",
        "summary": {"text": "벡터 검색은 의미를 비교합니다.", "references": [{"start_line": start_line, "end_line": end_line}]},
        "sections": [{"heading": "알아둘 점", "layout": "bullets", "items": [{
            "text": "도메인에 따라 정확도가 달라집니다.", "references": [{"start_line": start_line, "end_line": end_line}]
        }]}], "table": None,
    }}]})

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


async def test_structure_uses_no_tools_and_blank_answers_need_no_call(monkeypatch):
    parse = AsyncMock(return_value=SimpleNamespace(status="completed", output_parsed=cards()))
    client = SimpleNamespace(responses=SimpleNamespace(parse=parse), close=AsyncMock())
    monkeypatch.setattr("rabbit_hole.agent.AsyncOpenAI", lambda **kw: client)
    service = AgentService(Settings(_env_file=None, openai_api_key="fake"))
    assert (await service.structure("  ")).items == []
    parse.assert_not_called()
    assert (await service.structure(TEXT)).items[0].excerpt.quote == EXCERPT
    assert json.loads(parse.call_args.kwargs["input"]) == {"user_request": "", "answer_lines": numbered_lines(TEXT)}
    assert parse.call_args.kwargs["store"] is False and "tools" not in parse.call_args.kwargs
    parse.return_value = SimpleNamespace(status="completed", output_parsed=cards(3, 99))
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
        async def structure(self, text, user_request=""):
            Service.calls += 1
            assert user_request == "질문"
            return resolve_cards(text, cards())
        async def close(self):
            pass

    client = TestClient(create_app(settings, lambda _: Service()))
    body = {"request_id": str(uuid4()), "continuation": token, "text_hash": text_hash(TEXT)}
    response = client.post("/api/structure", json=body)
    assert response.status_code == 200
    assert response.json() == resolve_cards(TEXT, cards()).model_dump()
    assert client.post("/api/structure", json={**body, "continuation": "forged"}).status_code == 409
    assert client.post("/api/structure", json={**body, "text_hash": "a" * 64}).status_code == 409
    assert client.post("/api/structure", json={**body, "text": "injected"}).status_code == 422
    assert Service.calls == 1

    class Failure(Service):
        async def structure(self, text, user_request=""):
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
        async def structure(self, text, user_request=""):
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
        assert json.loads(payload["input"])["answer_lines"][2]["text"].strip() == EXCERPT
        assert payload["text"]["format"]["strict"] is True
        assert "tools" not in payload
        return httpx.Response(200, json={
            "id": "resp_test", "object": "response", "created_at": 0,
            "status": "completed", "model": "gpt-4.1-mini", "parallel_tool_calls": True,
            "tool_choice": "auto", "tools": [],
            "output": [{"id": "msg_test", "type": "message", "role": "assistant", "status": "completed",
                        "content": [{"type": "output_text", "text": cards().model_dump_json(),
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


def test_reorganized_cards_keep_discontinuous_field_references_and_conditions():
    text = "🐇 A는 간단합니다.\n관련 없는 내용\nB는 복잡합니다. 단, 설정 후에는 편리합니다."
    selected = cards(1, 1).model_dump()
    presentation = selected["items"][0]["presentation"]
    presentation["summary"]["references"].append({"start_line": 3, "end_line": 3})
    presentation["sections"][0]["items"][0]["references"] = [{"start_line": 3, "end_line": 3}]
    result = resolve_cards(text, CardSelections.model_validate(selected))
    assert result.version == 2
    references = result.items[0].presentation.summary.references
    assert len(references) == 2
    for ref in references:
        assert text[ref.start:ref.end] == ref.quote
    assert references[1].quote.endswith("설정 후에는 편리합니다.")
    assert result == resolve_cards(text, CardSelections.model_validate(selected))
    assert len(resolve_cards(text, CardSelections.model_validate({"items": selected["items"] * 2})).items) == 1


@pytest.mark.parametrize("first,last", [(0, 1), (1, 99), (3, 1), (2, 2)])
def test_reorganized_cards_reject_invalid_or_blank_references(first, last):
    with pytest.raises((ValueError, StageFailure)):
        resolve_cards(TEXT, cards(first, last))


def test_cards_allow_whole_answer_transformation_but_not_empty_or_malformed_tables():
    from pydantic import ValidationError
    text = "먼저 설치하고 실행합니다."
    assert resolve_cards(text, cards(1, 1)).items
    raw = cards().model_dump()
    card = raw["items"][0]["presentation"]
    cell = card["summary"]
    card["table"] = {"columns": [cell, cell], "rows": [[cell]]}
    with pytest.raises(ValidationError):
        CardSelections.model_validate(raw)
    card["table"]["rows"] = [[cell, None]]
    CardSelections.model_validate(raw)
    card.update(summary=None, sections=[], table=None)
    with pytest.raises(ValidationError):
        CardSelections.model_validate(raw)


async def test_short_comparison_uses_request_scope_without_tools(monkeypatch):
    parse = AsyncMock(return_value=SimpleNamespace(status="completed", output_parsed=CardSelections(items=[])))
    monkeypatch.setattr("rabbit_hole.agent.AsyncOpenAI", lambda **kw: SimpleNamespace(responses=SimpleNamespace(parse=parse)))
    result = await AgentService(Settings(_env_file=None, openai_api_key="fake")).structure("A는 쉽고 B는 복잡합니다.", user_request="차이만 짧게")
    assert result.version == 2 and result.items == []
    payload = parse.call_args.kwargs
    assert json.loads(payload["input"])["user_request"] == "차이만 짧게"
    assert "tools" not in payload and payload["store"] is False


async def test_substantial_single_topic_answers_are_partitioned_by_information_role(monkeypatch):
    parse = AsyncMock(return_value=SimpleNamespace(status="completed", output_parsed=CardSelections(items=[])))
    monkeypatch.setattr("rabbit_hole.agent.AsyncOpenAI", lambda **kw: SimpleNamespace(responses=SimpleNamespace(parse=parse)))
    text = (
        "# 개념\n벡터 검색은 의미 유사도를 이용합니다.\n"
        "# 동작 원리\n문서를 임베딩한 뒤 가까운 벡터를 찾습니다.\n"
        "# 비교\n키워드 검색은 단어 일치를 보고 벡터 검색은 의미를 비교합니다."
    )
    await AgentService(Settings(_env_file=None, openai_api_key="fake")).structure(text)
    instructions = parse.call_args.kwargs["instructions"]
    assert "partition the answer by independently useful information role" in instructions
    assert "SHOULD produce multiple cards" in instructions
    assert "even when every part concerns one overall topic" in instructions
    assert "Use a single card only when" in instructions
