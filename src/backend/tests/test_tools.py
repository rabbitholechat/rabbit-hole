import asyncio
import json
import socket
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from agents.tool_context import ToolContext

from rabbit_hole.config import Settings
from rabbit_hole.tools import AgentTools, ToolFailure, calculate, fetch_page, public_address, public_url

REAL_CLIENT = httpx.AsyncClient


def settings(**kwargs):
    return Settings(_env_file=None, **kwargs)


@pytest.mark.parametrize(("expression", "result"), [
    ("0.1 + 0.2", "0.3"), ("(12500 * 3) * (1 - 15 / 100)", "31875.00"),
    ("2 ** -3", "0.125"), ("-4 + +2", "-2"), (" 1 + 2 ", "3"),
])
def test_calculator_decimal_arithmetic(expression, result):
    assert calculate(expression) == result


@pytest.mark.parametrize("expression", [
    "__import__('os').environ", "(1).__class__", "[1,2]", "True", "1/0", "2**10000000",
    "9**9**9", "1e999999", "float('nan')", "1+" * 200, "1 // 2", "2 ** 0.5",
])
def test_calculator_rejects_code_and_unbounded_work(expression):
    with pytest.raises(ToolFailure):
        calculate(expression)


@pytest.mark.parametrize("url", [
    "file:///etc/passwd", "http://localhost/x", "http://127.0.0.1", "http://10.0.0.1",
    "http://169.254.169.254/latest", "http://[::1]", "http://[::ffff:127.0.0.1]",
    "https://user:secret@example.com", "https://example.com:8080", "https://x.internal",
    "http://224.0.0.1", "https://example.com/\nsecret", "http://2130706433",
])
def test_unsafe_urls(url):
    with pytest.raises(ToolFailure, match="unsafe_url"):
        public_url(url)


async def test_dns_rejects_any_private_answer(monkeypatch):
    resolver = AsyncMock(return_value=[
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443)),
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443)),
    ])
    monkeypatch.setattr(asyncio.get_running_loop(), "getaddrinfo", resolver)
    with pytest.raises(ToolFailure, match="unsafe_url"):
        await public_address(public_url("https://example.com"))


def mock_pages(monkeypatch, handler):
    monkeypatch.setattr("rabbit_hole.tools.public_address", AsyncMock(return_value="93.184.216.34"))
    monkeypatch.setattr("rabbit_hole.tools.httpx.AsyncClient", lambda **kwargs: REAL_CLIENT(
        transport=httpx.MockTransport(handler), **kwargs
    ))


async def test_page_pins_dns_and_preserves_host_and_tls_name(monkeypatch):
    def handler(request):
        assert request.url.host == "93.184.216.34"
        assert request.headers["host"] == "example.com"
        assert request.extensions["sni_hostname"] == "example.com"
        assert "cookie" not in request.headers and "authorization" not in request.headers
        return httpx.Response(200, headers={"content-type": "text/html"},
                              stream=httpx.ByteStream(b"<title>Page</title><script>SECRET</script><p>Hello</p>"))
    mock_pages(monkeypatch, handler)
    page = await fetch_page("https://example.com/a?q=1#section", settings())
    assert page == {"url": "https://example.com/a?q=1", "title": "Page", "text": "Hello", "truncated": False}


async def test_redirect_cannot_enter_private_network(monkeypatch):
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(302, headers={"location": "http://169.254.169.254/latest"})
    mock_pages(monkeypatch, handler)
    with pytest.raises(ToolFailure, match="unsafe_url"):
        await fetch_page("https://example.com", settings())
    assert len(calls) == 1


@pytest.mark.parametrize(("headers", "body", "code"), [
    ({"content-type": "application/pdf"}, b"PDF", "unsupported_content_type"),
    ({"content-type": "text/html", "content-encoding": "gzip"}, b"data", "unsupported_encoding"),
    ({"content-type": "text/plain"}, b"x" * 1025, "page_size_limit"),
    ({"content-type": "text/html"}, b"<script>only js</script>", "empty_page"),
])
async def test_page_limits(monkeypatch, headers, body, code):
    mock_pages(monkeypatch, lambda request: httpx.Response(200, headers=headers, stream=httpx.ByteStream(body)))
    with pytest.raises(ToolFailure, match=code):
        await fetch_page("https://example.com", settings(max_page_bytes=1024))


async def test_page_truncation_and_redirect_limit(monkeypatch):
    mock_pages(monkeypatch, lambda request: httpx.Response(
        200, headers={"content-type": "text/plain"}, stream=httpx.ByteStream(b"x" * 200)))
    page = await fetch_page("https://example.com", settings(max_page_chars=100))
    assert len(page["text"]) == 100 and page["truncated"]
    mock_pages(monkeypatch, lambda request: httpx.Response(302, headers={"location": "/loop"}))
    with pytest.raises(ToolFailure, match="redirect_limit"):
        await fetch_page("https://example.com", settings())


async def test_search_real_metadata_only_and_page_identity():
    payload = {"output": [
        {"type": "web_search_call", "status": "completed", "action": {"sources": [
            {"url": "https://example.com/a"}, {"url": "https://example.com/b"},
            {"url": "http://127.0.0.1"},
        ]}},
        {"type": "message", "content": [{"annotations": [
            {"type": "url_citation", "url": "https://example.com/a", "title": "Page A"},
        ]}]},
    ]}
    create = AsyncMock(return_value=SimpleNamespace(
        status="completed", output_text="Search summary", model_dump=lambda: payload))
    tools = AgentTools(settings(), SimpleNamespace(responses=SimpleNamespace(create=create)))
    result = await tools.web_search("test query")
    assert len(result["sources"]) == 2
    assert all(s["access"] == "search_result" and s["verification"] == "unverified" for s in result["sources"])
    assert result["sources"][0]["title"] == "Page A"
    source = tools.record("https://example.com/a#section", "Page A", "page_read")
    assert source.id == result["sources"][0]["id"]
    assert tools.record("https://example.com/a", "", "search_result").access == "page_read"
    assert tools.record("https://example.com/a?q=2", "", "search_result").id != source.id
    assert create.call_args.kwargs["store"] is False
    assert create.call_args.kwargs["max_tool_calls"] == 1
    payload["output"] = [{"type": "web_search_call", "status": "completed", "action": {"sources": []}}]
    assert (await tools.web_search("again"))["summary"] == ""
    with pytest.raises(ToolFailure, match="search_call_limit"):
        await tools.web_search("over budget")
    assert create.await_count == 2


async def test_tools_share_budget_and_sanitize_errors_without_swallowing_cancellation(monkeypatch):
    tools = AgentTools(settings(max_tool_calls=1), None)
    definitions = tools.definitions()
    context = ToolContext(context=None, tool_name="calculator", tool_call_id="call_test", tool_arguments="{}")
    assert (await definitions[0].on_invoke_tool(context, '{"expression":"1+2"}'))["result"] == "3"
    assert (await definitions[2].on_invoke_tool(context, '{"url":"https://example.com"}'))["code"] == "tool_call_limit"
    assert "invalid_tool_arguments" in await definitions[0].on_invoke_tool(context, '{"SECRET":1}')

    tools = AgentTools(settings(), None)
    monkeypatch.setattr("rabbit_hole.tools.fetch_page", AsyncMock(side_effect=RuntimeError("SECRET")))
    read = tools.definitions()[2]
    result = await read.on_invoke_tool(context, json.dumps({"url": "https://example.com"}))
    assert result == {"status": "failed", "code": "tool_failed"}
    monkeypatch.setattr("rabbit_hole.tools.fetch_page", AsyncMock(side_effect=asyncio.CancelledError))
    with pytest.raises(asyncio.CancelledError):
        await read.on_invoke_tool(context, '{"url":"https://example.com"}')


async def test_page_cancellation_closes_connection(monkeypatch):
    started, closed = asyncio.Event(), asyncio.Event()

    class PendingBody(httpx.AsyncByteStream):
        async def __aiter__(self):
            started.set()
            await asyncio.Event().wait()
            yield b"never"

        async def aclose(self):
            closed.set()

    mock_pages(monkeypatch, lambda request: httpx.Response(
        200, headers={"content-type": "text/plain"}, stream=PendingBody()))
    task = asyncio.create_task(fetch_page("https://example.com", settings()))
    await asyncio.wait_for(started.wait(), 1)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert closed.is_set()


@pytest.mark.parametrize(("hour", "utc_date", "seoul_date"), [
    (14, "2040-12-31", "2040-12-31"), (15, "2040-12-31", "2041-01-01"),
])
def test_current_date_context_preserves_utc_and_seoul_midnight(monkeypatch, hour, utc_date, seoul_date):
    from datetime import UTC, datetime

    from rabbit_hole.tools import current_date_context

    class Clock:
        @staticmethod
        def now(tz):
            return datetime(2040, 12, 31, hour, 0, tzinfo=UTC)

    monkeypatch.setattr("rabbit_hole.tools.datetime", Clock)
    context = current_date_context()
    assert f"Current date (UTC): {utc_date}" in context
    assert f"Current date (Asia/Seoul, UTC+09:00): {seoul_date}" in context
    assert "+09:00" in context
    assert "unless the user specifies" in context


async def test_cited_primary_page_is_not_lost_behind_discovered_sources():
    cited_url = "https://example.com/official-announcement"
    payload = {"output": [
        {"type": "web_search_call", "status": "completed", "action": {"sources": [
            {"url": f"https://example.com/old-{i}"} for i in range(45)
        ]}},
        {"type": "message", "content": [{"annotations": [
            {"type": "url_citation", "url": cited_url, "title": "Dated official announcement"},
        ]}]},
    ]}
    create = AsyncMock(return_value=SimpleNamespace(status="completed", output_text="Cited result",
                                                  model_dump=lambda: payload))
    tools = AgentTools(settings(), SimpleNamespace(responses=SimpleNamespace(create=create)))
    result = await tools.web_search("current announcement")
    assert len(result["sources"]) == 40
    assert result["sources"][0]["url"] == cited_url
    assert tools.record(cited_url, "", "search_result").title == "Dated official announcement"
    assert list(tools.sources.values())[0].url == cited_url


@pytest.mark.asyncio
async def test_source_content_parallel_budget_reuse_and_failure_isolation(monkeypatch):
    from rabbit_hole.models import SourceContent

    tools = AgentTools(settings(max_tool_calls=4, max_response_sources=6, max_source_concurrency=2), None)
    sources = [tools.record(f"https://example.com/{i}", str(i), "search_result") for i in range(6)]
    sources[0].content = SourceContent(status="read", text="cached", final_url=sources[0].url)
    sources[0].access = "page_read"
    active = peak = 0
    both_started = asyncio.Event()
    calls = []

    async def fetch(url, _settings):
        nonlocal active, peak
        calls.append(url)
        active += 1
        peak = max(peak, active)
        if active == 2:
            both_started.set()
        try:
            await asyncio.wait_for(both_started.wait(), 1)
            if url.endswith("/2"):
                raise ToolFailure("unsafe_url")
            return {"url": url + "/final", "title": "Actual title", "text": "<script>untrusted</script> Actual page",
                    "truncated": True}
        finally:
            active -= 1

    monkeypatch.setattr("rabbit_hole.tools.fetch_page", fetch)
    await tools.enrich_sources()
    assert peak == 2 and len(calls) == tools.calls == 4
    assert sources[0].url not in calls and sources[0].content.text == "cached"
    assert sources[1].content.status == "read" and sources[1].access == "page_read"
    assert sources[1].url == "https://example.com/1"
    assert sources[1].content.final_url.endswith("/final")
    assert sources[1].content.truncated
    assert sources[2].content.status == "failed" and sources[2].access == "search_result"
    assert sources[2].content.text == "" and sources[2].content.error_code == "page_unavailable"
    assert sources[5].content.status == "skipped"
    assert sources[5].content.error_code == "budget_exhausted"


@pytest.mark.asyncio
async def test_source_content_cancellation_stops_inflight_and_queued_reads(monkeypatch):
    tools = AgentTools(settings(max_source_concurrency=2), None)
    for i in range(5):
        tools.record(f"https://example.com/{i}", "", "search_result")
    started = asyncio.Event()
    active = 0

    async def fetch(url, _settings):
        nonlocal active
        active += 1
        if active == 2:
            started.set()
        try:
            await asyncio.Event().wait()
        finally:
            active -= 1

    monkeypatch.setattr("rabbit_hole.tools.fetch_page", fetch)
    task = asyncio.create_task(tools.enrich_sources())
    await asyncio.wait_for(started.wait(), 1)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert active == 0 and tools.calls == 2
    assert all(s.content.status == "failed" for s in tools.sources.values())


@pytest.mark.asyncio
async def test_agent_read_redirect_is_reused_and_only_displayed_sources_are_read(monkeypatch):
    tools = AgentTools(settings(max_response_sources=1), None)
    original = tools.record("https://example.com/original", "Original", "search_result")
    fetch = AsyncMock(return_value={"url": "https://example.com/final", "title": "Final",
                                   "text": "Actual original page text", "truncated": False})
    monkeypatch.setattr("rabbit_hole.tools.fetch_page", fetch)
    await tools.read_page(original.url)
    await tools.enrich_sources()
    assert fetch.await_count == 1 and tools.calls == 1
    assert original.content.text == "Actual original page text"
    assert original.content.final_url == "https://example.com/final"
    assert original.access == "page_read"

    tools = AgentTools(settings(max_response_sources=1), None)
    sources = [tools.record(f"https://example.com/{i}", "", "search_result") for i in range(3)]
    fetch.side_effect = TimeoutError()
    await tools.enrich_sources()
    assert tools.calls == 1
    assert sources[0].content.error_code == "page_timeout"
    assert sources[1].content is None and sources[2].content is None
