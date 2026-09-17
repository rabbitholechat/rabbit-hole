import json
from uuid import uuid4

from fastapi.testclient import TestClient

from rabbit_hole.app import create_app
from rabbit_hole.config import Settings
from rabbit_hole.models import Answer, SearchPlan


class FakeService:
    def __init__(self, settings, registry, budget, emit):
        self.registry, self.emit = registry, emit

    async def prepare(self, request, original_query):
        return SearchPlan(action="search", query=request.query, clarification=None)

    async def answer(self, request, original_query, search=True):
        s = self.registry.add(
            {
                "url": "https://example.com/article",
                "title": "Real fetched page",
                "content": "Evidence",
                "content_origin": "web_search_summary",
            }
        )
        await self.emit("sources", {"sources": [s.model_dump()]})
        return Answer(claims=[], limitation="요약만 확보")

    async def relationships(self):
        raise RuntimeError("secret provider failure")

    async def close(self):
        pass


def events(response):
    return [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]


def settings(**kwargs):
    return Settings(openai_api_key="fake", session_signing_key="x" * 32, **kwargs)


def test_partial_keeps_cards_and_sanitizes_error():
    client = TestClient(create_app(settings(), FakeService))
    request_id = str(uuid4())
    response = client.post("/api/search", json={"query": "vector", "request_id": request_id})
    assert response.status_code == 200
    data = events(response)
    assert all(e["request_id"] == request_id for e in data)
    assert any(
        e["type"] == "sources" and e["data"]["sources"][0]["title"] == "Real fetched page" for e in data
    )
    source = next(e["data"]["sources"][0] for e in data if e["type"] == "sources")
    assert source["content_origin"] == "web_search_summary"
    assert source["read_status"] == "summary" and source["excerpt"] == ""
    assert data[-1]["data"]["status"] == "partial"
    assert "secret provider failure" not in response.text
    assert "디자인 예시" not in response.text
    job = data[0]
    assert client.delete("/api/jobs/" + job["job_id"]).status_code == 404
    assert (
        client.delete(
            "/api/jobs/" + job["job_id"], headers={"Authorization": "Bearer " + job["data"]["access_token"]}
        ).status_code
        == 204
    )


def test_only_openai_key_is_required():
    client = TestClient(create_app(settings(), FakeService))
    assert client.get("/api/health").json()["configured"] is True


def test_missing_keys_explicit_error_no_sample():
    client = TestClient(create_app(Settings(openai_api_key="")))
    response = client.post("/api/search", json={"query": "vector", "request_id": str(uuid4())})
    assert response.status_code == 503
    assert "sources" not in response.json()


def test_rate_limit_input_and_forged_continuation():
    client = TestClient(create_app(settings(requests_per_minute=1), FakeService))
    body = {"query": "vector", "request_id": str(uuid4())}
    assert client.post("/api/search", json={**body, "query": " "}).status_code == 422
    assert client.post("/api/search", json={**body, "continuation": "fake"}).status_code == 409
    assert client.post("/api/search", json=body).status_code == 200
    assert client.post("/api/search", json=body).status_code == 429


def test_retry_uses_signed_sources_and_does_not_search():
    class RetryService(FakeService):
        async def answer(self, request, original_query, search=True):
            if request.retry_part:
                assert not search
                assert self.registry.sources
            return await super().answer(request, original_query, search)

    client = TestClient(create_app(settings(), RetryService))
    body = {"query": "vector", "request_id": str(uuid4())}
    data = events(client.post("/api/search", json=body))
    token = next(e["data"]["continuation"] for e in data if e["type"] == "checkpoint")
    response = client.post("/api/search", json={**body, "continuation": token, "retry_part": "answer"})
    assert events(response)[-1]["data"]["status"] == "completed"


def test_checkpoints_available_before_relation_failure():
    client = TestClient(create_app(settings(), FakeService))
    data = events(client.post("/api/search", json={"query": "vector", "request_id": str(uuid4())}))
    source_index = next(i for i, e in enumerate(data) if e["type"] == "sources")
    assert data[source_index + 1]["type"] == "checkpoint"


def test_runtime_sdk_agent_schemas_are_strict():
    from agents import AgentOutputSchema

    from rabbit_hole.models import Answer, Relationships

    for output in (Answer, Relationships):
        schema = AgentOutputSchema(output).json_schema()
        assert schema["additionalProperties"] is False


def test_body_size_rejected_before_model_execution():
    client = TestClient(create_app(settings(max_request_bytes=10000), FakeService))
    response = client.post("/api/search", content="x" * 10001, headers={"Content-Type": "application/json"})
    assert response.status_code == 413


async def test_disconnect_cancels_active_work_and_closes_service():
    import asyncio

    closed = asyncio.Event()
    source_sent = asyncio.Event()
    blocked = asyncio.Event()
    calls_after_wait = []

    class SlowService(FakeService):
        async def answer(self, request, original_query, search=True):
            await super().answer(request, original_query, search)
            await blocked.wait()
            calls_after_wait.append(True)
            return Answer(claims=[], limitation="")

        async def close(self):
            closed.set()

    app = create_app(settings(), SlowService)
    incoming = asyncio.Queue()
    payload = json.dumps({"query": "vector", "request_id": str(uuid4())}).encode()
    await incoming.put({"type": "http.request", "body": payload, "more_body": False})

    async def receive():
        return await incoming.get()

    async def send(event):
        if event["type"] == "http.response.body" and b"event: sources" in event.get("body", b""):
            source_sent.set()

    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": "/api/search",
        "raw_path": b"/api/search",
        "query_string": b"",
        "root_path": "",
        "headers": [(b"content-type", b"application/json")],
        "client": ("127.0.0.1", 1234),
        "server": ("localhost", 80),
    }
    task = asyncio.create_task(app(scope, receive, send))
    await asyncio.wait_for(source_sent.wait(), 2)
    await incoming.put({"type": "http.disconnect"})
    await asyncio.wait_for(task, 2)
    await asyncio.wait_for(closed.wait(), 2)
    assert not calls_after_wait
    assert all(job.finished and job.cancel.is_set() for job in app.state.store.jobs.values())


def test_timeout_preserves_sources_and_marks_unfinished_relationships():
    import asyncio

    class TimeoutService(FakeService):
        async def answer(self, request, original_query, search=True):
            await super().answer(request, original_query, search)
            await asyncio.sleep(10)

    client = TestClient(create_app(settings(job_timeout_seconds=1), TimeoutService))
    data = events(client.post("/api/search", json={"query": "vector", "request_id": str(uuid4())}))
    assert data[-1]["data"]["status"] == "partial"
    assert set(data[-1]["data"]["failed_parts"]) == {"answer", "relationships"}
    assert any(e["type"] == "sources" for e in data)


def test_openapi_declares_stream_contract():
    app = create_app(settings(), FakeService)
    content = app.openapi()["paths"]["/api/search"]["post"]["responses"]["200"]["content"]
    assert "text/event-stream" in content
    assert "application/json" not in content


def test_generic_clarification_signed_conversation_and_followup():
    from rabbit_hole.models import Clarification

    class ClarifyingService(FakeService):
        async def prepare(self, request, original_query):
            if len(self.conversation) == 1:
                return SearchPlan(
                    action="clarify",
                    query="",
                    clarification=Clarification(
                        message="기준을 알려주세요",
                        questions=["어떤 조건이 중요한가요?"],
                        suggestions=["특별한 선호는 없어요"],
                    ),
                )
            assert original_query == "검색 시스템 비교"
            assert [turn.role for turn in self.conversation] == ["user", "assistant", "user"]
            assert self.conversation[-1].content == "특별한 선호는 없어요"
            return SearchPlan(action="search", query=original_query, clarification=None)

    client = TestClient(create_app(settings(), ClarifyingService))
    first = events(
        client.post(
            "/api/search",
            json={
                "query": "검색 시스템 비교",
                "request_id": str(uuid4()),
            },
        )
    )
    clarification = next(e["data"] for e in first if e["type"] == "clarification")
    assert set(clarification) == {"message", "questions", "suggestions"}
    assert first[-1]["data"]["status"] == "awaiting_input"
    assert not any(e["type"] == "sources" for e in first)
    token = next(e["data"]["continuation"] for e in first if e["type"] == "checkpoint")
    second = events(
        client.post(
            "/api/search",
            json={
                "query": "특별한 선호는 없어요",
                "request_id": str(uuid4()),
                "continuation": token,
            },
        )
    )
    assert any(e["type"] == "sources" for e in second)
    assert not any(e["type"] == "clarification" for e in second)


def test_search_tool_failure_propagates_through_sdk_to_safe_sse_and_logs(caplog):
    from types import SimpleNamespace

    from agents.tool_context import ToolContext

    from rabbit_hole.search import SearchTools

    class FailingService(FakeService):
        def __init__(self, settings, registry, budget, emit):
            super().__init__(settings, registry, budget, emit)

            async def create(**kwargs):
                raise TimeoutError("SECRET provider body and raw query must never be logged")

            self.tools = SearchTools(
                registry, budget, emit, SimpleNamespace(responses=SimpleNamespace(create=create))
            )

        async def answer(self, request, original_query, search=True):
            tool = self.tools.sdk_tools()[0]
            arguments = json.dumps(
                {"query": "private query", "filters": {"topic": "general", "include_domains": []}}
            )
            ctx = ToolContext(
                context=None, tool_name=tool.name, tool_call_id="test", tool_arguments=arguments
            )
            await tool.on_invoke_tool(ctx, arguments)
            raise AssertionError("A failed search must not become a model fallback answer")

    client = TestClient(create_app(settings(external_retries=0), FailingService))
    response = client.post("/api/search", json={"query": "private query", "request_id": str(uuid4())})
    data = events(response)
    failures = [e["data"] for e in data if e["type"] == "part_error"]
    assert len(failures) == 1
    assert failures[0]["part"] == "search"
    assert failures[0]["code"] == "timeout"
    assert data[-1]["data"] == {"status": "failed", "failed_parts": ["search"]}
    assert not any(e["type"] == "answer" for e in data)
    assert "code=timeout" in caplog.text
    assert "SECRET" not in response.text + caplog.text
    assert "private query" not in caplog.text


def test_evidence_error_is_distinct_from_no_search_results():
    from rabbit_hole.errors import EvidenceValidationError

    class InvalidEvidenceService(FakeService):
        async def answer(self, request, original_query, search=True):
            await super().answer(request, original_query, search)
            raise EvidenceValidationError("raw model output")

    client = TestClient(create_app(settings(), InvalidEvidenceService))
    data = events(client.post("/api/search", json={"query": "test", "request_id": str(uuid4())}))
    failure = next(e["data"] for e in data if e["type"] == "part_error")
    assert failure["part"] == "answer" and failure["code"] == "invalid_evidence"
    assert data[-1]["data"]["status"] == "partial"


def test_internal_error_logs_location_without_raw_data_or_secondary_no_sources(caplog):
    class BrokenService(FakeService):
        async def answer(self, request, original_query, search=True):
            raise TypeError("SECRET raw response")

    client = TestClient(create_app(settings(), BrokenService))
    response = client.post("/api/search", json={"query": "test", "request_id": str(uuid4())})
    data = events(response)
    errors = [e["data"] for e in data if e["type"] == "part_error"]
    assert len(errors) == 1
    assert errors[0]["part"] == "answer" and errors[0]["code"] == "internal_error"
    assert "exception=TypeError" in caplog.text
    assert "test_api.py:" in caplog.text
    assert "SECRET" not in caplog.text + response.text
    assert "location" not in errors[0]  # Stack metadata stays on the server.
