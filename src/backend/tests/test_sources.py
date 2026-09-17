import asyncio
import time

import pytest

from rabbit_hole.config import Settings
from rabbit_hole.models import Answer, Claim, Evidence, Relation, Relationships, Snapshot
from rabbit_hole.search import Budget, Filters, SearchTools
from rabbit_hole.security import SnapshotSigner
from rabbit_hole.sources import Registry, normalize_url


def registry():
    r = Registry()
    a = r.add(
        {
            "url": "https://example.com/a?utm_source=x",
            "title": "A",
            "content": "Vector search uses embeddings.",
        }
    )
    b = r.add({"url": "https://example.com/b", "title": "B", "content": "Embeddings are vectors."})
    return r, a, b


def test_pages_preserved_tracking_deduplicated_and_query_kept():
    r, a, b = registry()
    assert a.id != b.id
    assert r.add({"url": "https://example.com/a?utm_source=another"}).id == a.id
    assert r.add({"url": "https://example.com/a?id=2"}).id != a.id
    assert normalize_url("https://example.com/?q=a&q=b#frag") == "https://example.com/?q=a&q=b"


@pytest.mark.parametrize(
    "url",
    [
        "javascript:alert(1)",
        "http://localhost/a",
        "http://127.0.0.1/",
        "http://169.254.169.254/",
        "https://user:pass@example.com",
        "http://[::1]/",
        "https://example.com:8080",
        "ftp://example.com",
    ],
)
def test_unsafe_urls(url):
    with pytest.raises(ValueError):
        normalize_url(url)


def test_nonexistent_citation_and_false_read_blocked():
    r, a, _ = registry()
    for evidence in [
        Evidence(source_id="made_up", quote="x", basis="summary"),
        Evidence(source_id=a.id, quote="Fabricated", basis="summary"),
        Evidence(source_id=a.id, quote=a.summary, basis="excerpt"),
    ]:
        with pytest.raises(ValueError):
            r.validate_answer(Answer(claims=[Claim(text="X", evidence=[evidence])], limitation=""))


def test_nonexistent_endpoint_and_one_sided_evidence_blocked():
    r, a, b = registry()
    e = Evidence(source_id=a.id, quote=a.summary, basis="summary")
    for target in ["fake", b.id]:
        edge = Relation(
            source=a.id,
            target=target,
            kind="same_topic",
            label="topic",
            explanation="test",
            evidence=[e],
            strength="core",
        )
        with pytest.raises(ValueError):
            r.validate_relationships(Relationships(relations=[edge], clusters=[]))


def test_server_budgets_and_cancel():
    budget = Budget(Settings(max_search_calls=1))
    budget.search()
    with pytest.raises(ValueError):
        budget.search()
    budget.cancelled.set()
    with pytest.raises(asyncio.CancelledError):
        budget.check()


def test_signed_continuation_tamper_and_sample_rejection():
    r, _, _ = registry()
    signer = SnapshotSigner("a" * 32)
    token = signer.sign(Snapshot(query="x", sources=list(r.sources.values()), issued_at=time.time()))
    assert len(signer.verify(token).sources) == 2
    with pytest.raises(ValueError):
        signer.verify(token + "x")
    with pytest.raises(ValueError):
        Snapshot(query="x", sources=[], issued_at=time.time(), mode="sample")


class Response:
    def __init__(self, data):
        self.data = data

    def model_dump(self):
        return self.data


class Client:
    def __init__(self, response=None, error=None):
        self.responses = self
        self.response = response
        self.error = error
        self.calls = []

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        return Response(self.response)


def web_response():
    text = "A fact. [A]\nB fact. [B]\nUncited https://invented.example/page"
    return {
        "status": "completed",
        "output": [
            {
                "type": "web_search_call",
                "status": "completed",
                "action": {
                    "type": "search",
                    "sources": [
                        {"type": "url", "url": "https://example.com/a?utm_source=x"},
                        {"type": "url", "url": "https://example.com/c"},
                        {"type": "url", "url": "http://127.0.0.1/"},
                    ],
                },
            },
            {
                "type": "message",
                "content": [
                    {
                        "type": "output_text",
                        "text": text,
                        "annotations": [
                            {
                                "type": "url_citation",
                                "url": "https://example.com/a",
                                "title": "A",
                                "start_index": 8,
                                "end_index": 11,
                            },
                            {
                                "type": "url_citation",
                                "url": "https://example.com/b",
                                "title": "B",
                                "start_index": 20,
                                "end_index": 23,
                            },
                        ],
                    }
                ],
            },
        ],
    }


async def noop(*args):
    pass


async def test_search_retry_is_charged():
    client = Client(error=TimeoutError())
    tools = SearchTools(Registry(), Budget(Settings(max_search_calls=1)), noop, client)
    with pytest.raises(ValueError):
        await tools.search_web("hello", Filters(topic="general", include_domains=[]))
    assert len(client.calls) == 1


async def test_registry_search_cap_and_hosted_search_contract(monkeypatch):
    async def public(url):
        return normalize_url(url)

    monkeypatch.setattr("rabbit_hole.search.public_url", public)
    client = Client(web_response())
    r = Registry()
    tools = SearchTools(r, Budget(Settings(max_sources=2)), noop, client)
    result = await tools.search_web("test", Filters(topic="general", include_domains=["example.com"]))
    assert len(r.sources) == 2
    assert [s["summary"] for s in result] == ["A fact.", "B fact."]
    assert all(s["read_status"] == "summary" and not s["excerpt"] for s in result)
    assert all(s["content_origin"] == "web_search_summary" for s in result)
    call = client.calls[0]
    assert call["tools"] == [
        {"type": "web_search", "external_web_access": True, "filters": {"allowed_domains": ["example.com"]}}
    ]
    assert call["max_tool_calls"] == 1
    assert call["tool_choice"] == "required"
    assert call["include"] == ["web_search_call.action.sources"]
    assert call["store"] is False


async def test_cancelled_tools_never_call_provider():
    client = Client(web_response())
    budget = Budget(Settings())
    budget.cancelled.set()
    tools = SearchTools(Registry(), budget, noop, client)
    with pytest.raises(asyncio.CancelledError):
        await tools.search_web("test", Filters(topic="general", include_domains=[]))
    assert not client.calls


def test_only_provider_citations_supply_page_evidence():
    from rabbit_hole.search import web_sources

    result = web_sources(web_response())
    assert len(result) == 3  # Deduplicated URL, no private or model-invented URL.
    assert result[-1]["content"] == ""  # Consulted does not mean cited.
    response = web_response()
    part = response["output"][1]["content"][0]
    part["text"] = part["text"].replace("\n", " ")
    assert all(not p["content"] for p in web_sources(response))  # Ambiguous attribution.
    response = web_response()
    response["output"][1]["content"][0]["annotations"][0]["end_index"] = 999
    assert web_sources(response)[0]["content"] == ""


@pytest.mark.parametrize("status", ["failed", "incomplete"])
def test_failed_search_cannot_promote_model_memory_to_sources(status):
    from rabbit_hole.search import web_sources

    response = web_response()
    response["status"] = status
    with pytest.raises(ValueError):
        web_sources(response)
    response["status"] = "completed"
    response["output"][0]["status"] = "failed"
    with pytest.raises(ValueError):
        web_sources(response)


async def test_semantic_verification_removes_unsupported_claim(monkeypatch):
    from uuid import uuid4

    from rabbit_hole.models import SearchRequest, Verification
    from rabbit_hole.search import AgentService

    r, a, _ = registry()
    answer = Answer(
        claims=[
            Claim(
                text="All search is always perfectly accurate.",
                evidence=[Evidence(source_id=a.id, quote=a.summary, basis="summary")],
            )
        ],
        limitation="",
    )

    async def emit(*args):
        pass

    settings = Settings(openai_api_key="fake")
    service = AgentService(settings, r, Budget(settings), emit)

    async def run(agent, prompt):
        if agent.name == "SearchAgentEvidenceCheck":
            return Verification(supported_claim_indices=[])
        return answer

    monkeypatch.setattr(service, "run", run)
    try:
        result = await service.answer(SearchRequest(query="x", request_id=uuid4()), "x", search=False)
        assert not result.claims
        assert "제외" in result.limitation
    finally:
        await service.close()


def test_new_summary_can_enrich_consulted_page_without_replacing_existing_evidence():
    r = Registry()
    source = r.add({"url": "https://example.com/page", "content_origin": "web_search_summary"})
    r.add({"url": source.url, "content": "Cited summary", "content_origin": "web_search_summary"})
    r.add({"url": source.url, "content": "Different summary", "content_origin": "web_search_summary"})
    assert source.summary == "Cited summary"
    source.excerpt, source.read_status = source.summary, "read"
    assert not r.evidence(Evidence(source_id=source.id, quote=source.summary, basis="excerpt"))
    assert r.evidence(Evidence(source_id=source.id, quote=source.summary, basis="summary"))


async def test_real_openai_sdk_serializes_hosted_tool_without_network(monkeypatch):
    import json

    import httpx
    from openai import AsyncOpenAI

    async def public(url):
        return normalize_url(url)

    monkeypatch.setattr("rabbit_hole.search.public_url", public)
    requests = []

    def handle(request):
        requests.append(json.loads(request.content))
        return httpx.Response(200, json=web_response())

    async with AsyncOpenAI(
        api_key="fake", max_retries=0, http_client=httpx.AsyncClient(transport=httpx.MockTransport(handle))
    ) as client:
        tools = SearchTools(Registry(), Budget(Settings()), noop, client)
        sources = await tools.search_web("한국어 검색", Filters(topic="news", include_domains=[]))
    assert len(requests) == 1
    assert requests[0]["tools"][0]["type"] == "web_search"
    assert sources[0]["summary"] == "A fact."
    assert sources[0]["content_origin"] == "web_search_summary"


async def test_cancellation_during_provider_call_does_not_register_results():
    budget = Budget(Settings())

    class CancellingClient(Client):
        async def create(self, **kwargs):
            budget.cancelled.set()
            return await super().create(**kwargs)

    registry = Registry()
    tools = SearchTools(registry, budget, noop, CancellingClient(web_response()))
    with pytest.raises(asyncio.CancelledError):
        await tools.search_web("test", Filters(topic="general", include_domains=[]))
    assert not registry.sources


@pytest.mark.parametrize(
    "status,code",
    [
        (400, "provider_request_error"),
        (401, "provider_auth_error"),
        (403, "provider_auth_error"),
        (429, "provider_rate_limit"),
        (500, "provider_error"),
    ],
)
def test_provider_diagnostics_never_use_raw_error_text(status, code):
    import httpx
    from openai import APIStatusError

    from rabbit_hole.errors import error_code

    error = APIStatusError(
        "sensitive provider response",
        response=httpx.Response(status, request=httpx.Request("POST", "https://api.example.com")),
        body={"secret": "hidden"},
    )
    assert error_code(error) == code


@pytest.mark.parametrize(
    "case,expected",
    [
        ("unknown", "unknown_source_id"),
        ("blank", "empty_quote"),
        ("ai_excerpt", "ai_summary_as_excerpt"),
        ("unread", "original_not_read"),
        ("empty_text", "empty_source_text"),
        ("mismatch", "quote_not_found"),
        ("valid", None),
    ],
)
def test_evidence_diagnostics_distinguish_rejection_conditions(case, expected):
    r, a, _ = registry()
    evidence = Evidence(source_id=a.id, quote=a.summary, basis="summary")
    if case == "unknown":
        evidence.source_id = "missing"
    elif case == "blank":
        evidence.quote = " "
    elif case == "ai_excerpt":
        a.content_origin = "web_search_summary"
        evidence.basis = "excerpt"
    elif case == "unread":
        evidence.basis = "excerpt"
    elif case == "empty_text":
        a.summary = ""
    elif case == "mismatch":
        evidence.quote = "translated text"
    assert r.evidence_reason(evidence) == expected


def test_debug_logs_every_bad_evidence_and_is_silent_when_disabled(monkeypatch):
    import json

    from rabbit_hole import diagnostics

    logs = []
    monkeypatch.setattr(diagnostics.logger, "debug", logs.append)
    monkeypatch.setattr(diagnostics.logger, "error", logs.append)
    monkeypatch.setattr(diagnostics.logger, "warning", logs.append)
    r, a, b = registry()
    answer = Answer(
        claims=[
            Claim(text="one", evidence=[Evidence(source_id=a.id, quote="mismatch", basis="summary")]),
            Claim(text="two", evidence=[Evidence(source_id=b.id, quote="", basis="summary")]),
        ],
        limitation="",
    )
    with pytest.raises(ValueError):
        r.validate_answer(answer)
    assert logs == []
    r.debug, r.request_id = True, "request-test"
    with pytest.raises(ValueError):
        r.validate_answer(answer)
    records = [json.loads(line) for line in logs]
    assert [record["reason"] for record in records] == ["quote_not_found", "empty_quote"]
    assert [record["claim_index"] for record in records] == [0, 1]
    assert all(record["request_id"] == "request-test" for record in records)


async def test_debug_search_logs_all_candidates_and_registered_ids(monkeypatch):
    import json

    from rabbit_hole import diagnostics

    async def public(url):
        return normalize_url(url)

    logs = []
    monkeypatch.setattr(diagnostics.logger, "debug", logs.append)
    monkeypatch.setattr(diagnostics.logger, "error", logs.append)
    monkeypatch.setattr(diagnostics.logger, "warning", logs.append)
    monkeypatch.setattr("rabbit_hole.search.public_url", public)
    r = Registry(debug=True, request_id="request-test")
    tools = SearchTools(r, Budget(Settings(max_sources=2)), noop, Client(web_response()))
    await tools.search_web("test", Filters(topic="general", include_domains=[]))
    records = [json.loads(line) for line in logs]
    assert len([record for record in records if record["event"] == "search_source"]) == 3
    registered = [record["source"] for record in records if record["event"] == "source_registered"]
    assert len(registered) == 2
    assert {source["id"] for source in registered} == set(r.sources)
    assert registered[0]["summary"] == "A fact."
    assert any(record.get("reason") == "source_limit" for record in records)


def test_debug_mode_activation(monkeypatch):
    from rabbit_hole import diagnostics

    monkeypatch.setattr(diagnostics.sys, "gettrace", lambda: None)
    assert not diagnostics.enabled(False)
    assert diagnostics.enabled(True)
    monkeypatch.setattr(diagnostics.sys, "gettrace", lambda: object())
    assert diagnostics.enabled(False)


def test_markdown_is_the_canonical_evidence_text():
    r = Registry()
    source = r.add(
        {
            "url": "https://example.com/page",
            "content": "Released on **September 9, 2024**.",
            "content_origin": "web_search_summary",
        }
    )
    assert r.evidence(
        Evidence(source_id=source.id, quote="Released on **September 9, 2024**.", basis="summary")
    )
    assert (
        r.evidence_reason(
            Evidence(source_id=source.id, quote="Released on September 9, 2024.", basis="summary")
        )
        == "quote_not_found"
    )


def test_diagnostic_severity_and_terminal_colors(monkeypatch):
    import logging

    from uvicorn.logging import DefaultFormatter

    from rabbit_hole import diagnostics

    levels = []
    monkeypatch.setattr(diagnostics.logger, "debug", lambda message: levels.append("debug"))
    monkeypatch.setattr(diagnostics.logger, "warning", lambda message: levels.append("warning"))
    monkeypatch.setattr(diagnostics.logger, "error", lambda message: levels.append("error"))
    for event in ("search_source", "source_rejected", "evidence_rejected", "validation_rejected"):
        diagnostics.write(True, "test", event)
    assert levels == ["debug", "warning", "error", "error"]
    record = logging.LogRecord("test", logging.ERROR, "", 0, "rejected", (), None)
    assert "\x1b[" in DefaultFormatter("%(levelprefix)s %(message)s", use_colors=True).format(record)
