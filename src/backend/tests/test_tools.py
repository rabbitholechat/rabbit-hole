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


async def test_search_real_metadata_only_and_page_identity(monkeypatch):
    monkeypatch.setattr(AgentTools, "image_search", AsyncMock(return_value={"sources": []}))
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
    assert len(result["sources"]) == 1
    assert all(s["access"] == "search_result" and s["verification"] == "unverified" for s in result["sources"])
    assert result["sources"][0]["title"] == "Page A"
    assert "https://example.com/b" not in {s.url for s in tools.sources.values()}
    assert [candidate["url"] for candidate in result["candidates"]] == ["https://example.com/b"]
    assert create.call_args.kwargs["include"] == ["web_search_call.action.sources"]
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


async def test_only_cited_primary_page_is_kept_from_discovered_sources(monkeypatch):
    monkeypatch.setattr(AgentTools, "image_search", AsyncMock(return_value={"sources": []}))
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
    assert len(result["sources"]) == 1
    assert result["sources"][0]["url"] == cited_url
    assert tools.record(cited_url, "", "search_result").title == "Dated official announcement"
    assert [source.url for source in tools.sources.values()] == [cited_url]


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
    assert sources[2].content.text == "" and sources[2].content.error_code == "unsafe_url"
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


@pytest.mark.asyncio
async def test_compressed_article_extraction_and_bounded_truncation(monkeypatch):
    import gzip

    article = "<article><h1>Article</h1><p>Actual facts.</p></article>"
    html = ("<head><script>" + "x" * 1_100_000 + "</script></head><nav>Menu</nav>"
            "<main>" + article + "</main><footer>Footer</footer>").encode()
    mock_pages(monkeypatch, lambda request: httpx.Response(
        200, headers={"content-type": "text/html", "content-encoding": "gzip"},
        stream=httpx.ByteStream(gzip.compress(html))))
    page = await fetch_page("https://example.com", settings())
    assert page["text"] == "Article\nActual facts." and not page["truncated"]

    # A compressed bomb stops at the decoded ceiling; only the bounded prefix is retained.
    mock_pages(monkeypatch, lambda request: httpx.Response(
        200, headers={"content-type": "text/plain", "content-encoding": "gzip"},
        stream=httpx.ByteStream(gzip.compress(b"x" * 100_000))))
    page = await fetch_page("https://example.com", settings(max_page_decoded_bytes=1024))
    assert len(page["text"]) == 1024 and page["truncated"]

    mock_pages(monkeypatch, lambda request: httpx.Response(
        200, headers={"content-type": "text/plain"}, stream=httpx.ByteStream(b"x" * 1025)))
    page = await fetch_page("https://example.com", settings(max_page_bytes=1024))
    assert len(page["text"]) == 1024 and page["truncated"]


class SummaryStream:
    def __init__(self, events):
        self.events = events
        self.closed = False

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        self.closed = True

    async def __aiter__(self):
        for event in self.events:
            yield event


@pytest.mark.asyncio
async def test_source_summaries_publish_progress_and_isolate_model_failure(monkeypatch):
    async def create(**kwargs):
        assert "tools" not in kwargs and kwargs["store"] is False and kwargs["stream"] is True
        data = json.loads(kwargs["input"])
        assert data["text"].startswith("Only page")
        if data["title"] == "bad":
            raise TimeoutError()
        return SummaryStream([
            SimpleNamespace(type="response.reasoning_text.delta", delta="PRIVATE"),
            SimpleNamespace(type="response.output_text.delta", delta="• 이 페이지의"),
            SimpleNamespace(type="response.output_text.delta", delta=" 핵심 내용입니다."),
            SimpleNamespace(type="response.completed", response=SimpleNamespace(status="completed")),
        ])

    client = SimpleNamespace(responses=SimpleNamespace(create=AsyncMock(side_effect=create)))
    tools = AgentTools(settings(max_source_summaries=2), client)
    for title in ("good", "bad", "limited"):
        tools.record("https://example.com/" + title, title, "search_result")

    async def fetch(url, _settings):
        return {"url": url, "title": url.rsplit("/", 1)[1], "text": "Only page text", "truncated": False}

    monkeypatch.setattr("rabbit_hole.tools.fetch_page", fetch)
    snapshots = []

    async def update():
        snapshots.append([s.model_dump() for s in tools.sources.values()])

    await tools.enrich_sources(update)
    assert all(s["content"]["status"] == "reading" for s in snapshots[0])
    assert any(s["content"]["status"] == "summarizing" for batch in snapshots for s in batch)
    assert any(s["content"]["status"] == "summarizing" and s["content"]["summary"] == "• 이 페이지의"
               for batch in snapshots for s in batch)
    assert "PRIVATE" not in str(snapshots)
    sources = list(tools.sources.values())
    assert sources[0].content.summary == "• 이 페이지의 핵심 내용입니다."
    assert sources[1].content.status == "read" and sources[1].content.summary_error == "summary_timeout"
    assert sources[2].content.summary_error == "summary_budget_exhausted"
    assert client.responses.create.await_count == 2
    assert all(s.content.text == "Only page text" for s in sources)


@pytest.mark.asyncio
async def test_partial_summary_failure_closes_stream_and_preserves_public_text(monkeypatch):
    stream = SummaryStream([
        SimpleNamespace(type="response.output_text.delta", delta="부분 요약"),
        SimpleNamespace(type="response.incomplete"),
    ])
    client = SimpleNamespace(responses=SimpleNamespace(create=AsyncMock(return_value=stream)))
    tools = AgentTools(settings(), client)
    source = tools.record("https://example.com/a", "Title", "search_result")
    monkeypatch.setattr("rabbit_hole.tools.fetch_page", AsyncMock(return_value={
        "url": source.url, "title": source.title, "text": "Actual page", "truncated": False,
    }))
    await tools.enrich_sources()
    assert stream.closed
    assert source.content.summary == "부분 요약"
    assert source.content.summary_error == "summary_unavailable"
    assert source.content.status == "read"


@pytest.mark.asyncio
async def test_summary_cancellation_closes_provider_stream_and_retains_partial_text(monkeypatch):
    entered = asyncio.Event()

    class WaitingStream(SummaryStream):
        async def __aiter__(self):
            yield SimpleNamespace(type="response.output_text.delta", delta="받은 요약")
            entered.set()
            await asyncio.Event().wait()

    stream = WaitingStream([])
    tools = AgentTools(settings(), SimpleNamespace(responses=SimpleNamespace(create=AsyncMock(return_value=stream))))
    source = tools.record("https://example.com/a", "Title", "search_result")
    monkeypatch.setattr("rabbit_hole.tools.fetch_page", AsyncMock(return_value={
        "url": source.url, "title": source.title, "text": "Actual page", "truncated": False,
    }))
    task = asyncio.create_task(tools.enrich_sources())
    await asyncio.wait_for(entered.wait(), 1)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert stream.closed
    assert source.content.summary == "받은 요약"
    assert source.content.summary_error == "summary_timeout"


@pytest.mark.asyncio
async def test_image_search_real_metadata_budget_and_no_page_summary(monkeypatch):
    payload = {"query": {"pages": [
        {"index": 1, "title": "File:Rabbit.jpg", "imageinfo": [{
            "descriptionurl": "https://commons.wikimedia.org/wiki/File:Rabbit.jpg",
            "thumburl": "https://thumb.wikimedia.org/wikipedia/commons/thumb/r/rabbit.jpg",
            "mime": "image/jpeg"}]},
        {"index": 2, "title": "File:Unsafe.jpg", "imageinfo": [{
            "descriptionurl": "https://commons.wikimedia.org/wiki/File:Unsafe.jpg",
            "thumburl": "http://127.0.0.1/private", "mime": "image/jpeg"}]},
    ]}}

    def handler(request):
        assert request.url.host == "commons.wikimedia.org"
        assert request.url.params["generator"] == "search"
        return httpx.Response(200, json=payload)

    mock_pages(monkeypatch, handler)
    tools = AgentTools(settings(max_web_searches=1), None)
    result = await tools.image_search("rabbit")
    assert result["status"] == "ok" and len(result["sources"]) == 1
    assert result["sources"][0]["title"] == "Rabbit.jpg"
    assert result["sources"][0]["verification"] == "unverified"
    assert tools.calls == tools.image_searches == 1 and tools.searches == 0
    fetch = AsyncMock()
    monkeypatch.setattr("rabbit_hole.tools.fetch_page", fetch)
    await tools.enrich_sources()
    fetch.assert_not_called()
    assert list(tools.sources.values())[0].content is None
    with pytest.raises(ToolFailure, match="image_search_limit"):
        await tools.image_search("again")


@pytest.mark.asyncio
async def test_image_search_empty_results_do_not_invent_cards(monkeypatch):
    mock_pages(monkeypatch, lambda request: httpx.Response(200, json={"batchcomplete": True}))
    tools = AgentTools(settings(), None)
    assert (await tools.image_search("missing"))["status"] == "no_sources"
    assert not tools.sources


@pytest.mark.asyncio
@pytest.mark.parametrize("unsafe", [False, True])
async def test_page_image_is_published_only_after_summary(monkeypatch, unsafe):
    tools = AgentTools(settings(), None)
    source = tools.record("https://example.com/news", "Product", "search_result")
    monkeypatch.setattr("rabbit_hole.tools.fetch_page", AsyncMock(return_value={
        "url": source.url, "title": source.title, "text": "Actual body",
        "truncated": False, "image_url": "https://images.example.com/a.jpg",
    }))
    monkeypatch.setattr("rabbit_hole.tools.public_address", AsyncMock(
        side_effect=ToolFailure("unsafe_url") if unsafe else None))

    async def summarize(item, publish):
        assert item.page_image is None
        assert item.image is None
        return "페이지 요약"

    monkeypatch.setattr(tools, "summarize_source", summarize)
    await tools.enrich_sources()
    assert source.content.summary == "페이지 요약"
    assert source.image is None
    assert (source.page_image is None) == unsafe
    if not unsafe:
        assert source.page_image.thumbnail_url == "https://images.example.com/a.jpg"
    assert tools.calls == 1


async def test_korean_subject_context_survives_wrong_name_candidates_and_query_refinement():
    wrong = {"output": [{"type": "web_search_call", "status": "completed", "action": {"sources": [
        {"url": "https://example.com/wrong-person", "title": "전효성 소속사 소식"}
    ]}}]}
    correct = {"output": [
        {"type": "web_search_call", "status": "completed", "action": {"sources": [
            {"url": "https://example.com/album", "title": "전소연 새 앨범"}
        ]}},
        {"type": "message", "content": [{"annotations": [
            {"type": "url_citation", "url": "https://example.com/album", "title": "전소연 새 앨범"}
        ]}]},
    ]}
    create = AsyncMock(side_effect=[
        SimpleNamespace(status="completed", output_text="대상이 다른 결과로 확인 불가", model_dump=lambda: wrong),
        SimpleNamespace(status="completed", output_text="전소연 관련 자료", model_dump=lambda: correct),
    ])
    tools = AgentTools(settings(), SimpleNamespace(responses=SimpleNamespace(create=create)))
    tools.user_request = "전소연 새 앨범"
    first = await tools.web_search("전소연 새 앨범")
    assert first["remaining_searches"] == 1
    assert first["remaining_tool_calls"] == 7
    assert "unreviewed discovery URLs" in first["usage_notice"]
    # A candidate is available for relevance review but never registered as evidence/source.
    assert first["status"] == "candidates_only" and first["sources"] == [] and first["summary"] == ""
    assert first["candidates"][0]["title"] == "전효성 소속사 소식"
    assert tools.displayed_sources() == []
    second = await tools.web_search('"전소연" 앨범 발매')
    assert second["remaining_searches"] == 0
    assert second["remaining_tool_calls"] == 6
    assert second["sources"][0]["title"] == "전소연 새 앨범"
    for call, query in zip(create.call_args_list, ["전소연 새 앨범", '"전소연" 앨범 발매'], strict=True):
        args = call.kwargs
        payload = json.loads(args["input"])
        assert payload["query"] == query and payload["user_request"] == "전소연 새 앨범"
        assert payload["temporal_focus"] == "unspecified"
        assert "never substitute" in args["instructions"]
        assert "subject identity AND topic relevance" in args["instructions"]
        assert args["max_tool_calls"] == 1 and args["store"] is False
    with pytest.raises(ToolFailure, match="search_call_limit"):
        await tools.web_search("세 번째 검색")
    assert create.await_count == 2


async def test_empty_search_reports_remaining_budget_without_exposing_uncited_summary():
    create = AsyncMock(return_value=SimpleNamespace(status="completed", output_text="근거 없는 내용",
        model_dump=lambda: {"output": [{"type": "web_search_call", "status": "completed", "action": {"sources": []}}]}))
    tools = AgentTools(settings(), SimpleNamespace(responses=SimpleNamespace(create=create)))
    result = await tools.web_search("한국어 검색")
    assert result["status"] == "no_sources" and result["summary"] == ""
    assert result["remaining_searches"] == 1
    assert "no relevant results does not mean nonexistence" in result["usage_notice"]


@pytest.mark.parametrize("focus,query,expected", [
    ("current", "전소연 새 앨범", "전소연 새 앨범"),
    ("current", "전소연 2041 앨범", "전소연 2041 앨범"),
    ("historical", "전소연 2021 앨범", "전소연 2021 앨범"),
    ("unspecified", "전소연 앨범", "전소연 앨범"),
])
async def test_search_temporal_intent_uses_server_seoul_year_without_changing_history(monkeypatch, focus, query, expected):
    from datetime import UTC, datetime

    class Clock:
        @staticmethod
        def now(tz):
            return datetime(2040, 12, 31, 16, tzinfo=UTC)

    monkeypatch.setattr("rabbit_hole.tools.datetime", Clock)
    create = AsyncMock(return_value=SimpleNamespace(status="completed", output_text="",
        model_dump=lambda: {"output": [{"type": "web_search_call", "status": "completed", "action": {"sources": []}}]}))
    tools = AgentTools(settings(), SimpleNamespace(responses=SimpleNamespace(create=create)))
    result = await tools.web_search(query, temporal_focus=focus)
    payload = json.loads(create.call_args.kwargs["input"])
    assert payload["query"] == expected
    assert payload["reference_date"] == "2041-01-01"
    assert payload["temporal_focus"] == focus
    assert result["reference_date"] == "2041-01-01"
    assert payload["reference_time"] == "2041-01-01T01:00:00+09:00"
    assert payload["search_window"] is None and result["search_window"] is None
    assert "do not impose a publication-date restriction" in create.call_args.kwargs["instructions"]
    assert create.call_args.kwargs["tools"][0]["external_web_access"] is True
    assert "only historical results" in create.call_args.kwargs["instructions"]
    assert "full reference_date" in create.call_args.kwargs["instructions"]
    assert "Search ranking is not proof of freshness" in create.call_args.kwargs["instructions"]


async def test_uncited_discovery_recovers_by_reading_without_extra_search_or_automatic_sources(monkeypatch):
    url = "https://example.com/current-product"
    create = AsyncMock(return_value=SimpleNamespace(status="completed", output_text="uncited generated claim",
        model_dump=lambda: {"output": [{"type": "web_search_call", "status": "completed", "action": {"sources": [
            {"url": url, "title": "Current product"}, {"url": url + "#overview"},
            {"url": "http://127.0.0.1/private"}, {"url": "javascript:alert(1)"}, {"url": None},
        ]}}]}))
    tools = AgentTools(settings(), SimpleNamespace(responses=SimpleNamespace(create=create)))
    found = await tools.web_search("current product", temporal_focus="current")
    assert found["status"] == "candidates_only" and found["summary"] == "" and found["sources"] == []
    assert len(found["candidates"]) == 1 and found["candidates"][0]["verification"] == "unverified"
    assert tools.displayed_sources() == []
    fetch = AsyncMock(return_value={"url": url, "title": "Current product", "text": "Actual page text", "truncated": False})
    monkeypatch.setattr("rabbit_hole.tools.fetch_page", fetch)
    read = await tools.read_page(found["candidates"][0]["url"])
    assert read["content_origin"] == "page_text" and read["text"] == "Actual page text"
    assert tools.displayed_sources()[0].url == url
    assert tools.calls == 2 and tools.searches == 1 and create.await_count == 1
    fetch.assert_awaited_once()


async def test_discovery_candidates_are_bounded_and_do_not_trigger_enrichment(monkeypatch):
    create = AsyncMock(return_value=SimpleNamespace(status="completed", output_text="",
        model_dump=lambda: {"output": [{"type": "web_search_call", "status": "completed", "action": {"sources": [
            {"url": f"https://example.com/{i}", "title": "x" * 1000} for i in range(50)
        ]}}]}))
    tools = AgentTools(settings(), SimpleNamespace(responses=SimpleNamespace(create=create)))
    result = await tools.web_search("query")
    assert len(result["candidates"]) == 20
    assert all(len(candidate["title"]) == 500 for candidate in result["candidates"])
    fetch = AsyncMock()
    monkeypatch.setattr("rabbit_hole.tools.fetch_page", fetch)
    await tools.enrich_sources()
    fetch.assert_not_called()
    assert tools.calls == 1


async def test_temporal_focus_function_tool_dispatches_and_rejects_unknown_scope():
    create = AsyncMock(return_value=SimpleNamespace(status="completed", output_text="",
        model_dump=lambda: {"output": [{"type": "web_search_call", "status": "completed", "action": {"sources": []}}]}))
    tools = AgentTools(settings(), SimpleNamespace(responses=SimpleNamespace(create=create)))
    definition = tools.definitions()[1]
    context = ToolContext(context=None, tool_name="web_search", tool_call_id="call_test", tool_arguments="{}")
    result = await definition.on_invoke_tool(context, json.dumps({"query": "전소연 새 앨범", "temporal_focus": "current"}))
    assert result["temporal_focus"] == "current"
    assert json.loads(create.call_args.kwargs["input"])["temporal_focus"] == "current"
    with pytest.raises(ToolFailure, match="invalid_temporal_focus"):
        await tools.web_search("query", temporal_focus="unknown")
    assert create.await_count == 1


async def test_search_passes_direct_results_even_when_summary_prefers_another_page(monkeypatch):
    generic = "https://example.com/home"
    relevant = "https://example.com/event"
    body = "행사 일정은 이전 공지에 있습니다. [행사](https://example.com/event)"
    start = body.index("[행사]")
    payload = {"output": [
        {"type": "web_search_call", "status": "completed", "action": {"sources": [
            {"url": generic, "title": "홈페이지"},
            {"url": relevant, "title": "행사 일정", "snippet": "실제 도구 스니펫"},
            {"url": "https://example.com/uncited", "title": "세부 참가 방법", "snippet": "참가 안내"},
            {"url": "http://127.0.0.1/private", "snippet": "unsafe"},
        ]}},
        {"type": "message", "content": [{"text": body, "annotations": [
            {"type": "url_citation", "url": relevant, "title": "행사 일정", "start_index": start,
             "end_index": len(body), "snippet": "not provider metadata"},
            {"type": "url_citation", "url": generic, "start_index": -1, "end_index": 99999},
        ]}]},
    ]}
    create = AsyncMock(return_value=SimpleNamespace(status="completed", output_text=body, model_dump=lambda: payload))
    tools = AgentTools(settings(), SimpleNamespace(responses=SimpleNamespace(create=create)))
    result = await tools.web_search("Wanted 2026 Championship Korea", temporal_focus="current")
    by_url = {entry["url"]: entry for entry in result["results"]}
    assert set(by_url) == {generic, relevant, "https://example.com/uncited"}
    assert by_url[generic]["snippet"] is None and by_url[generic]["summary_excerpts"] == []
    assert by_url[relevant]["snippet"] == "실제 도구 스니펫"
    assert by_url[relevant]["summary_excerpts"] == [body]
    assert by_url[relevant]["cited_in_summary"] is True
    assert result["candidates"] == [by_url["https://example.com/uncited"]]
    assert all(s.url != "https://example.com/uncited" for s in tools.displayed_sources())
    # A lower-listed result is available for targeted reading without a new search or reranker.
    fetch = AsyncMock(return_value={"url": relevant, "title": "행사 일정", "text": "실제 본문", "truncated": False})
    monkeypatch.setattr("rabbit_hole.tools.fetch_page", fetch)
    read = await tools.read_page(by_url[relevant]["url"])
    assert read["text"] == "실제 본문" and tools.searches == 1 and tools.calls == 2
    assert create.await_count == 1


async def test_direct_result_metadata_limits_and_uncited_summary_isolation():
    payload = {"output": [{"type": "web_search_call", "status": "completed", "action": {"sources": [
        {"url": f"https://example.com/{i}", "title": "t" * 900, "snippet": "s" * 3000} for i in range(60)
    ]}}]}
    create = AsyncMock(return_value=SimpleNamespace(status="completed", output_text="uncited claim", model_dump=lambda: payload))
    tools = AgentTools(settings(), SimpleNamespace(responses=SimpleNamespace(create=create)))
    result = await tools.web_search("event")
    assert len(result["results"]) == 40 and len(result["candidates"]) == 20
    assert all(len(r["title"]) == 500 and len(r["snippet"]) == 2000 for r in result["results"])
    assert all(r["summary_excerpts"] == [] and not r["cited_in_summary"] for r in result["results"])
    assert result["summary"] == "" and result["sources"] == [] and tools.displayed_sources() == []


async def test_answer_selected_source_wins_display_cap_and_enrichment(monkeypatch):
    tools = AgentTools(settings(max_response_sources=1), None)
    generic = tools.record("https://example.com/event", "Generic", "search_result")
    relevant = tools.record("https://example.com/event/details", "Specific", "search_result")
    tools.prioritize_answer_sources(
        "[가짜](https://unseen.example.com/) [구체적인 일정](https://example.com/event/details#schedule)"
    )
    assert tools.displayed_sources() == [relevant]
    assert len(tools.sources) == 2  # Generated links never become source metadata.
    fetch = AsyncMock(return_value={"url": relevant.url, "title": relevant.title,
                                   "text": "실제 일정", "truncated": False})
    monkeypatch.setattr("rabbit_hole.tools.fetch_page", fetch)
    await tools.enrich_sources()
    fetch.assert_awaited_once_with(relevant.url, tools.settings)
    assert generic.content is None


def test_answer_source_priority_does_not_confuse_query_pages():
    tools = AgentTools(settings(), None)
    plain = tools.record("https://example.com/event", "", "search_result")
    first = tools.record("https://example.com/event?id=1", "", "search_result")
    second = tools.record("https://example.com/event?id=10", "", "search_result")
    tools.prioritize_answer_sources("[일정](https://example.com/event?id=10)")
    assert tools.displayed_sources() == [second, plain, first]
