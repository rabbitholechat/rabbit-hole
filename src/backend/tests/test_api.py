import asyncio
import json
import logging
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from openai import APIError

from rabbit_hole import diagnostics
from rabbit_hole.app import create_app
from rabbit_hole.config import Settings
from rabbit_hole.models import ConversationTurn, Snapshot, ToolSource
from rabbit_hole.security import SnapshotSigner


class FakeService:
    inputs = []

    def __init__(self, settings):
        pass

    async def stream(self, conversation):
        self.inputs.append(conversation)
        yield "안녕하세요. **"
        yield "응답**입니다."

    async def close(self):
        pass


def events(response):
    return [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]


def settings(**kwargs):
    return Settings(_env_file=None, openai_api_key="fake", session_signing_key="x" * 32, **kwargs)


def body(**kwargs):
    return {"query": "비교 기준을 정리해줘", "request_id": str(uuid4()), **kwargs}


def test_stream_contract_and_signed_followup():
    client = TestClient(create_app(settings(), FakeService))
    first = events(client.post("/api/agent", json=body()))
    assert [e["type"] for e in first] == [
        "started",
        "checkpoint",
        "response_started",
        "status",
        "response_delta",
        "response_delta",
        "response_completed",
        "checkpoint",
        "done",
    ]
    assert [e["seq"] for e in first] == list(range(1, len(first) + 1))
    assert all(e["version"] == 2 for e in first)
    text = "".join(e["data"]["delta"] for e in first if e["type"] == "response_delta")
    assert next(e["data"]["text"] for e in first if e["type"] == "response_completed") == text
    assert first[-1]["data"] == {"status": "completed", "failed_parts": []}
    token = [e["data"]["continuation"] for e in first if e["type"] == "checkpoint"][-1]
    client.post("/api/agent", json=body(query="더 자세히", continuation=token))
    assert [(t.role, t.content) for t in FakeService.inputs[-1]] == [
        ("user", "비교 기준을 정리해줘"),
        ("assistant", text),
        ("user", "더 자세히"),
    ]
    started = first[0]
    assert client.delete("/api/jobs/" + started["job_id"]).status_code == 404
    assert (
        client.delete(
            "/api/jobs/" + started["job_id"],
            headers={
                "Authorization": "Bearer " + started["data"]["access_token"],
            },
        ).status_code
        == 204
    )


def test_configuration_limits_and_incompatible_requests():
    missing = TestClient(create_app(Settings(_env_file=None, openai_api_key=""), FakeService))
    assert missing.post("/api/agent", json=body()).status_code == 503
    client = TestClient(create_app(settings(requests_per_minute=1), FakeService))
    assert client.get("/api/health").json()["api_version"] == 2
    assert client.post("/api/agent", json=body(query=" ")).status_code == 422
    assert client.post("/api/agent", json=body(focus_source_id="src_x")).status_code == 422
    assert client.post("/api/agent", json=body(continuation="forged")).status_code == 409
    assert client.post("/api/agent", json=body()).status_code == 200
    assert client.post("/api/agent", json=body()).status_code == 429
    assert client.post("/api/search", json=body()).status_code == 404


def test_tool_sources_contract_without_page_body_or_invented_sources():
    source = ToolSource(id="src_" + "a" * 24, url="https://example.com/page", title="Page",
                        access="page_read", accessed_at="2026-09-17T00:00:00+00:00")

    class SourcedService(FakeService):
        sources = [source]

    client = TestClient(create_app(settings(), SourcedService))
    result = events(client.post("/api/agent", json=body()))
    record = next(e for e in result if e["type"] == "response_sources")
    completed = next(e for e in result if e["type"] == "response_completed")
    assert record["data"] == {"id": completed["data"]["id"], "sources": [source.model_dump()]}
    assert completed["seq"] < record["seq"] < result[-1]["seq"]
    assert result[-1]["data"]["status"] == "completed"
    plain = events(TestClient(create_app(settings(), FakeService)).post("/api/agent", json=body()))
    assert not any(e["type"] == "response_sources" for e in plain)


def test_body_limit():
    client = TestClient(create_app(settings(max_request_bytes=10000), FakeService))
    assert (
        client.post(
            "/api/agent", content="x" * 10001, headers={"Content-Type": "application/json"}
        ).status_code
        == 413
    )


@pytest.mark.parametrize("failure_kind", ["timeout", "provider_error"])
@pytest.mark.parametrize("partial", [False, True])
def test_partial_failure_preserves_text_but_does_not_commit_unfinished_turn(caplog, failure_kind, partial):
    class FailingService(FakeService):
        async def stream(self, conversation):
            if partial:
                yield "받은 내용"
            if failure_kind == "provider_error":
                raise APIError(
                    "SECRET raw provider body",
                    request=httpx.Request("POST", "https://api.openai.com/v1/responses"),
                    body={"message": "SECRET", "code": "server_error"},
                )
            raise TimeoutError("SECRET raw provider body")

    caplog.set_level(logging.DEBUG, logger=diagnostics.logger.name)
    diagnostics.logger.addHandler(caplog.handler)
    try:
        client = TestClient(create_app(settings(debug_diagnostics=True), FailingService))
        result = client.post("/api/agent", json=body(query="PRIVATE input"))
        data = events(result)
        assert data[-1]["data"] == {"status": "partial" if partial else "failed", "failed_parts": ["response"]}
        assert [e["data"]["delta"] for e in data if e["type"] == "response_delta"] == (["받은 내용"] if partial else [])
        failure = next(e["data"] for e in data if e["type"] == "part_error")
        assert failure["code"] == failure_kind
        token = [e["data"]["continuation"] for e in data if e["type"] == "checkpoint"][-1]
        assert SnapshotSigner("x" * 32).verify(token).conversation == []
        assert "SECRET" not in result.text + caplog.text
        assert "PRIVATE" not in caplog.text
        assert "받은 내용" not in caplog.text
        assert {r.levelname for r in caplog.records} >= {"INFO", "DEBUG", "ERROR"}
        assert "location" in caplog.text
    finally:
        diagnostics.logger.removeHandler(caplog.handler)


def test_timeout_and_empty_response():
    class Slow(FakeService):
        async def stream(self, conversation):
            await asyncio.sleep(5)
            yield "too late"

    client = TestClient(create_app(settings(job_timeout_seconds=1), Slow))
    data = events(client.post("/api/agent", json=body()))
    assert data[-1]["data"]["status"] == "failed"
    assert next(e["data"]["code"] for e in data if e["type"] == "part_error") == "timeout"

    class Empty(FakeService):
        async def stream(self, conversation):
            yield ""

    data = events(TestClient(create_app(settings(), Empty)).post("/api/agent", json=body()))
    assert data[-1]["data"]["status"] == "failed"
    assert next(e["data"]["code"] for e in data if e["type"] == "part_error") == "invalid_output"


def test_output_limit_context_budget_and_expiry():
    from rabbit_hole.app import trim_context

    class Long(FakeService):
        async def stream(self, conversation):
            yield "first"
            yield "x" * 64000

    data = events(TestClient(create_app(settings(), Long)).post("/api/agent", json=body()))
    assert next(e["data"]["code"] for e in data if e["type"] == "part_error") == "output_limit"
    turns = [ConversationTurn(role=role, content="x" * 30000) for role in ["user", "assistant"] * 4]
    remaining = trim_context(turns, settings(max_context_turns=4))
    assert len(remaining) == 2 and remaining[0].role == "user"
    signer = SnapshotSigner("x" * 32)
    expired = signer.sign(Snapshot(conversation=[], issued_at=0))
    assert (
        TestClient(create_app(settings(), FakeService))
        .post("/api/agent", json=body(continuation=expired))
        .status_code
        == 409
    )


async def test_disconnect_cancels_work_and_closes_service():
    closed, sent, blocked = asyncio.Event(), asyncio.Event(), asyncio.Event()

    class Slow(FakeService):
        async def stream(self, conversation):
            yield "first"
            await blocked.wait()
            raise AssertionError("work continued")

        async def close(self):
            closed.set()

    app = create_app(settings(), Slow)
    incoming = asyncio.Queue()
    await incoming.put({"type": "http.request", "body": json.dumps(body()).encode(), "more_body": False})

    async def receive():
        return await incoming.get()

    async def send(event):
        if event["type"] == "http.response.body" and b"event: response_delta" in event.get("body", b""):
            sent.set()

    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": "/api/agent",
        "raw_path": b"/api/agent",
        "query_string": b"",
        "root_path": "",
        "headers": [(b"content-type", b"application/json")],
        "client": ("127.0.0.1", 1234),
        "server": ("localhost", 80),
    }
    task = asyncio.create_task(app(scope, receive, send))
    await asyncio.wait_for(sent.wait(), 2)
    await incoming.put({"type": "http.disconnect"})
    await asyncio.wait_for(task, 2)
    await asyncio.wait_for(closed.wait(), 2)
    assert all(j.finished and j.cancel.is_set() for j in app.state.store.jobs.values())


def test_openapi_matches_checked_in_contract():
    from pathlib import Path

    schema = create_app(settings(), FakeService).openapi()
    assert "text/event-stream" in schema["paths"]["/api/agent"]["post"]["responses"]["200"]["content"]
    assert schema == json.loads((Path(__file__).parents[3] / "docs/openapi.json").read_text())


def test_v1_continuation_is_rejected_without_model_call():
    import base64
    import hashlib
    import hmac
    import time

    raw = base64.urlsafe_b64encode(
        json.dumps({"query": "old", "sources": [], "issued_at": time.time()}).encode()
    ).decode()
    token = raw + "." + hmac.new(b"x" * 32, raw.encode(), hashlib.sha256).hexdigest()
    client = TestClient(create_app(settings(), FakeService))
    assert client.post("/api/agent", json=body(continuation=token)).status_code == 409


def test_background_title_contract_and_failure_isolation():
    class TitleService(FakeService):
        async def title(self, conversation):
            assert [t.role for t in conversation] == ["user", "assistant"]
            return "비교 기준 정리"

    client = TestClient(create_app(settings(), TitleService))
    result = events(client.post("/api/agent", json=body()))
    checkpoints = [e["data"]["continuation"] for e in result if e["type"] == "checkpoint"]
    request = {"request_id": str(uuid4()), "continuation": checkpoints[-1]}
    assert client.post("/api/title", json=request).json() == {"title": "비교 기준 정리"}
    assert client.post("/api/title", json={**request, "continuation": checkpoints[0]}).status_code == 409
    assert client.post("/api/title", json={**request, "continuation": "bad"}).status_code == 409

    class BrokenTitle(TitleService):
        async def title(self, conversation):
            raise TimeoutError()

    failed = TestClient(create_app(settings(), BrokenTitle))
    assert failed.post("/api/title", json=request).status_code == 502
    assert events(failed.post("/api/agent", json=body()))[-1]["data"]["status"] == "completed"
    assert all(j.finished for j in failed.app.state.store.jobs.values())


def test_branch_uses_selected_signed_response_context():
    client = TestClient(create_app(settings(), FakeService))
    first = events(client.post('/api/agent', json=body(query='A')))
    token = [e['data']['continuation'] for e in first if e['type'] == 'checkpoint'][-1]
    client.post('/api/agent', json=body(query='B', continuation=token))
    client.post('/api/agent', json=body(query='C', continuation=token))
    assert [t.content for t in FakeService.inputs[-1] if t.role == 'user'] == ['A', 'C']


def test_selected_node_context_is_explicit_user_data_in_signed_conversation():
    seen = []
    class ContextService(FakeService):
        async def stream(self, conversation):
            seen.extend(conversation)
            yield "선택한 자료에 대한 답변"
    context = {"node_id": "info_test", "kind": "information", "title": "개념", "text": "정확한 원문 발췌"}
    client = TestClient(create_app(settings(), ContextService))
    response = client.post('/api/agent', json={**body(query="자세히 설명해줘"), "node_context": context})
    data = events(response)
    assert response.status_code == 200
    assert seen[-1].content.startswith("자세히 설명해줘")
    assert context["text"] in seen[-1].content
    token = [e["data"]["continuation"] for e in data if e["type"] == "checkpoint"][-1]
    signed = SnapshotSigner("x" * 32).verify(token)
    assert signed.conversation[-2].content == seen[-1].content
    assert client.post('/api/agent', json={**body(), "node_context": {**context, "text": "x" * 12001}}).status_code == 422


@pytest.mark.parametrize("limit", [5, 2])
def test_response_sources_have_server_configured_limit(limit):
    class ManySources(FakeService):
        sources = [ToolSource(id=f"src_{i:024x}", url=f"https://example.com/{i}", title=f"Page {i}",
                              access="search_result", accessed_at="2026-09-17T00:00:00Z") for i in range(8)]
    configured = settings(max_response_sources=limit)
    result = events(TestClient(create_app(configured, ManySources)).post("/api/agent", json=body()))
    sources = next(e["data"]["sources"] for e in result if e["type"] == "response_sources")
    assert len(sources) == limit
    assert sources[0]["id"] == "src_" + "0" * 24
    assert len(ManySources.sources) == 8
    assert Settings(_env_file=None).max_response_sources == 5


@pytest.mark.parametrize("fail", [False, True])
def test_page_enrichment_contract_preserves_answer_and_excludes_body_from_checkpoint(fail):
    from rabbit_hole.models import SourceContent

    class EnrichedService(FakeService):
        def __init__(self, configured):
            self.sources = [ToolSource(id="src_" + "a" * 24, url="https://example.com/a", title="Page",
                                      access="search_result", accessed_at="2026-09-17T00:00:00Z")]

        async def enrich_sources(self, on_update=None):
            if fail:
                raise TimeoutError()
            self.sources[0].content = SourceContent(status="reading")
            await on_update()
            self.sources[0].access = "page_read"
            self.sources[0].content = SourceContent(status="summarizing", text="PRIVATE_PAGE_TEST_TEXT",
                                                   final_url="https://example.com/a")
            await on_update()
            self.sources[0].content.summary = "페이지"
            await on_update()
            self.sources[0].content.status = "read"
            self.sources[0].content.summary = "페이지 요약"
            await on_update()

    configured = settings()
    result = events(TestClient(create_app(configured, EnrichedService)).post("/api/agent", json=body()))
    assert result[-1]["data"]["status"] == "completed"
    assert not any(e["type"] == "part_error" for e in result)
    completed = next(e for e in result if e["type"] == "response_completed")
    reading = next(e for e in result if e["type"] == "status" and e["data"]["stage"] == "reading_sources")
    snapshots = [e for e in result if e["type"] == "response_sources"]
    sources = snapshots[-1]
    if not fail:
        assert [e["data"]["sources"][0]["content"]["status"] for e in snapshots] == ["reading", "summarizing", "summarizing", "read", "read"]
        assert snapshots[2]["data"]["sources"][0]["content"]["summary"] == "페이지"
    assert completed["seq"] < reading["seq"] < sources["seq"]
    content = sources["data"]["sources"][0]["content"]
    assert content is None if fail else content["text"] == "PRIVATE_PAGE_TEST_TEXT"
    checkpoint = [e for e in result if e["type"] == "checkpoint"][-1]["data"]["continuation"]
    assert "PRIVATE_PAGE_TEST_TEXT" not in str(SnapshotSigner("x" * 32).verify(checkpoint).conversation)


def test_image_sources_sse_contract():
    from rabbit_hole.models import ImagePreview

    class ImageService(FakeService):
        sources = [ToolSource(
            id="src_" + "a" * 24, title="Rabbit",
            url="https://commons.wikimedia.org/wiki/File:Rabbit.jpg",
            access="search_result", accessed_at="2026-09-17T00:00:00Z",
            image=ImagePreview(thumbnail_url="https://upload.wikimedia.org/rabbit.jpg"),
        )]

        async def enrich_sources(self, on_update=None):
            raise AssertionError("Image cards must not trigger page summaries")

    result = events(TestClient(create_app(settings(), ImageService)).post("/api/agent", json=body()))
    snapshot = next(e for e in result if e["type"] == "response_sources")
    assert snapshot["data"]["sources"] == [ImageService.sources[0].model_dump()]
    assert result[-1]["data"]["status"] == "completed"
    assert not any(e["type"] == "status" and e["data"]["stage"] == "reading_sources" for e in result)


def test_summarized_page_image_sse_contract():
    from rabbit_hole.models import ImagePreview, SourceContent

    class PageImageService(FakeService):
        sources = [ToolSource(
            id="src_" + "b" * 24, title="Page", url="https://example.com/page",
            access="search_result", accessed_at="2026-09-17T00:00:00Z",
        )]

        async def enrich_sources(self, on_update=None):
            await on_update()
            source = self.sources[0]
            source.access = "page_read"
            source.content = SourceContent(status="read", text="Page body", summary="페이지 요약", final_url=source.url)
            source.page_image = ImagePreview(thumbnail_url="https://example.com/photo.jpg")
            await on_update()

    result = events(TestClient(create_app(settings(), PageImageService)).post("/api/agent", json=body()))
    snapshots = [e["data"]["sources"][0] for e in result if e["type"] == "response_sources"]
    assert snapshots[0]["page_image"] is None
    assert snapshots[-1]["page_image"] == {"thumbnail_url": "https://example.com/photo.jpg"}
    assert snapshots[-1]["content"]["summary"] == "페이지 요약"
    assert snapshots[-1]["image"] is None
