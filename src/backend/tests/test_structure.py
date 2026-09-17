import asyncio
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from rabbit_hole.agent import AgentService
from rabbit_hole.app import create_app
from rabbit_hole.config import Settings
from rabbit_hole.models import ConversationTurn, Snapshot
from rabbit_hole.security import SnapshotSigner
from rabbit_hole.structure import ExtractCandidate, ExtractCandidates, text_hash, validate_extracts

TEXT = "🐇 원래 답변입니다.\n\n벡터 검색은 의미를 비교합니다. 단, 도메인에 따라 정확도가 달라집니다.\n\n" + "추가 설명을 그대로 보존합니다. " * 8
EXCERPT = "벡터 검색은 의미를 비교합니다. 단, 도메인에 따라 정확도가 달라집니다."


def candidates(excerpt=EXCERPT, title="벡터 검색"):
    return ExtractCandidates(items=[ExtractCandidate(subtype="concept", title=title, excerpt=excerpt)])


def test_extracts_are_exact_codepoint_spans_and_deterministic():
    first = validate_extracts(TEXT, candidates())
    item = first.items[0]
    assert item.excerpt.start == TEXT.index(EXCERPT)
    assert TEXT[item.excerpt.start:item.excerpt.end] == EXCERPT
    assert TEXT[item.title.start:item.title.end] == "벡터 검색"
    assert first == validate_extracts(TEXT, candidates())
    assert validate_extracts(TEXT, ExtractCandidates(items=candidates().items * 2)) == first
    assert validate_extracts(TEXT, candidates(TEXT)).items == []


@pytest.mark.parametrize(("text", "candidate"), [
    (TEXT, candidates("새로 만들어낸 사실입니다.")),
    (TEXT, candidates(title="원문에 없는 제목")),
    (TEXT + EXCERPT, candidates()),
])
def test_invented_or_ambiguous_extraction_rejected(text, candidate):
    with pytest.raises(ValueError, match="invalid_extract"):
        validate_extracts(text, candidate)


async def test_structure_uses_no_tools_and_short_answers_need_no_call(monkeypatch):
    parse = AsyncMock(return_value=SimpleNamespace(status="completed", output_parsed=candidates()))
    client = SimpleNamespace(responses=SimpleNamespace(parse=parse), close=AsyncMock())
    monkeypatch.setattr("rabbit_hole.agent.AsyncOpenAI", lambda **kw: client)
    service = AgentService(Settings(_env_file=None, openai_api_key="fake"))
    assert (await service.structure("짧은 답변")).items == []
    parse.assert_not_called()
    assert (await service.structure(TEXT)).items[0].excerpt.quote == EXCERPT
    assert parse.call_args.kwargs["input"] == TEXT
    assert parse.call_args.kwargs["store"] is False and "tools" not in parse.call_args.kwargs
    parse.return_value = SimpleNamespace(status="completed", output_parsed=candidates(title="invented"))
    with pytest.raises(ValueError):
        await service.structure(TEXT)
    await service.close()


def test_structure_contract_signed_text_and_failure_isolation():
    settings = Settings(_env_file=None, openai_api_key="fake", session_signing_key="x" * 32)
    signer = SnapshotSigner("x" * 32)
    token = signer.sign(Snapshot(issued_at=time.time(), conversation=[
        ConversationTurn(role="user", content="질문"), ConversationTurn(role="assistant", content=TEXT)]))

    class Service:
        calls = 0
        async def structure(self, text):
            Service.calls += 1
            return validate_extracts(text, candidates())
        async def close(self):
            pass

    client = TestClient(create_app(settings, lambda _: Service()))
    body = {"request_id": str(uuid4()), "continuation": token, "text_hash": text_hash(TEXT)}
    response = client.post("/api/structure", json=body)
    assert response.status_code == 200
    assert response.json() == validate_extracts(TEXT, candidates()).model_dump()
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
