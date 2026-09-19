import base64
import io
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from pypdf import PdfWriter
from test_agent import StreamResult, event
from test_history import MemoryHistory, session

from rabbit_hole.agent import AgentService
from rabbit_hole.app import create_app
from rabbit_hole.attachments import AttachmentFailure, model_inputs, prepare_attachment
from rabbit_hole.config import Settings
from rabbit_hole.models import ConversationTurn


def settings(**kwargs):
    return Settings(_env_file=None, openai_api_key="fake", session_signing_key="s" * 32, **kwargs)


def png():
    out = io.BytesIO()
    Image.new("RGBA", (80, 50), (30, 160, 90, 180)).save(out, "PNG")
    return out.getvalue()


def pdf(pages=1, encrypted=False):
    writer = PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(100, 100)
    if encrypted:
        writer.encrypt("secret")
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


class MemoryAttachments:
    def __init__(self):
        self.rows = {}
        self.claimed = set()

    def create(self, record):
        self.rows[str(record["metadata"].id)] = record
        return record["metadata"]

    def get_many(self, ids, claim=False):
        if any(str(key) not in self.rows for key in ids):
            raise AttachmentFailure("첨부 자료를 찾을 수 없습니다.", 404)
        if claim:
            self.claimed.update(str(key) for key in ids)
        return {str(key): self.rows[str(key)] for key in ids}

    def delete_draft(self, key):
        if str(key) not in self.claimed:
            self.rows.pop(str(key), None)


@pytest.mark.parametrize("name,raw,kind,mime", [
    ("그림.png", png(), "image", "image/png"),
    ("계획.md", "첫 줄\n두 번째 줄".encode(), "file", "text/plain"),
    ("문서.pdf", pdf(), "file", "application/pdf"),
])
def test_upload_original_preview_and_shared_restore_without_model(name, raw, kind, mime):
    repository = MemoryAttachments()
    history = MemoryHistory()
    def no_model(*args):
        raise AssertionError("No model during upload or restore")
    first = TestClient(create_app(settings(), no_model, history, repository))
    response = first.post("/api/attachments", params={"filename": name}, content=raw)
    assert response.status_code == 201
    meta = response.json()
    assert meta["name"] == name and meta["kind"] == kind and meta["media_type"] == mime
    original = first.get(meta["download_url"])
    assert original.content == raw and original.headers["content-disposition"].startswith("attachment;")
    assert original.headers["x-content-type-options"] == "nosniff"
    if kind == "image":
        preview = first.get(meta["preview_url"])
        assert preview.headers["content-type"] == "image/jpeg"
        assert Image.open(io.BytesIO(preview.content)).size == (80, 50)
    record = session(nodes=[{"id": f"attachment_{meta['id']}", "type": "attachment", "position": {"x": 12, "y": -250},
                             "data": {"attachment": meta}}])
    assert first.put("/api/sessions/shared-session", json={"session": record, "revision": 0}).status_code == 200
    second = TestClient(create_app(settings(), no_model, history, repository))
    assert second.get("/api/sessions/shared-session").json()["session"] == record
    assert second.get(meta["download_url"]).content == raw


@pytest.mark.parametrize("name,raw", [
    ("fake.png", b"plain text"), ("bad.pdf", b"not pdf"), ("private.pdf", pdf(encrypted=True)),
    ("large.pdf", pdf(3)), ("script.exe", b"MZ"), ("empty.txt", b""),
    ("binary.txt", b"\x00\x01"), ("cp949.txt", b"\xff\xfe"), ("large.txt", b"x" * 1001),
])
def test_rejects_invalid_attachments(name, raw):
    with pytest.raises(AttachmentFailure):
        prepare_attachment(raw, name, settings(max_attachment_pdf_pages=2, max_attachment_text_chars=1000))


def test_attachment_binary_limit_is_independent_and_draft_removal():
    repository = MemoryAttachments()
    client = TestClient(create_app(settings(max_request_bytes=10000, max_attachment_bytes=20000), attachment_repository=repository))
    assert client.post("/api/attachments?filename=a.txt", content=b"x" * 20001).status_code == 413
    response = client.post("/api/attachments?filename=a.txt", content=b"x" * 15000)
    assert response.status_code == 201
    key = response.json()["id"]
    assert client.delete(f"/api/attachments/{key}").status_code == 204
    assert client.get(f"/api/attachments/{key}").status_code == 404
    assert client.post("/api/agent", content=b"x" * 15000).status_code == 413


def test_attachment_request_context_and_missing_ids_without_paid_call():
    seen = []
    class Service:
        def __init__(self, _settings):
            pass
        async def stream(self, conversation, *, requested_tool=None, attachment_data=None):
            seen.append((conversation, attachment_data))
            yield "첨부 자료의 답변"
        async def close(self):
            pass
    repository = MemoryAttachments()
    client = TestClient(create_app(settings(), Service, attachment_repository=repository))
    meta = client.post("/api/attachments?filename=note.txt", content="자료".encode()).json()
    response = client.post("/api/agent", json={"request_id": str(uuid4()), "attachment_ids": [meta["id"]]})
    from test_api import events
    stream = events(response)
    assert stream[-1]["data"]["status"] == "completed"
    token = [e["data"]["continuation"] for e in stream if e["type"] == "checkpoint"][-1]
    assert seen[0][0][-1].content == "첨부한 자료를 설명해 주세요."
    assert seen[0][1][meta["id"]]["model_data"] == "자료".encode()
    client.post("/api/agent", json={"request_id": str(uuid4()), "query": "더 설명해줘", "continuation": token})
    assert seen[1][0][0].attachment_ids == [UUID(meta["id"])] and meta["id"] in seen[1][1]
    client.delete(f"/api/attachments/{meta['id']}")
    assert client.get(meta["download_url"]).status_code == 200
    count = len(seen)
    assert client.post("/api/agent", json={"request_id": str(uuid4()), "attachment_ids": [str(uuid4())]}).status_code == 404
    assert len(seen) == count
    assert client.post("/api/agent", json={"request_id": str(uuid4()), "attachment_ids": [meta["id"]] * 2}).status_code == 422


async def test_agent_multimodal_input_uses_files_not_source_urls(monkeypatch):
    records = [prepare_attachment(raw, name, settings()) for name, raw in [("image.png", png()), ("file.pdf", pdf()), ("a.txt", b"actual text")]]
    by_id = {str(r["metadata"].id): r for r in records}
    turns = [ConversationTurn(role="user", content="자료 분석", attachment_ids=list(by_id))]
    monkeypatch.setattr("rabbit_hole.agent.AsyncOpenAI", lambda **kw: SimpleNamespace(close=AsyncMock()))
    run = Mock(return_value=StreamResult([event("response.output_text.delta", delta="분석"),
        event("response.completed", response=SimpleNamespace(status="completed"))]))
    monkeypatch.setattr("rabbit_hole.agent.Runner.run_streamed", run)
    service = AgentService(settings())
    assert [part async for part in service.stream(turns, attachment_data=by_id)] == ["분석"]
    payload = run.call_args.kwargs["input"][0]["content"]
    image = next(p for p in payload if p["type"] == "input_image")
    assert base64.b64decode(image["image_url"].split(",")[1]) == records[0]["model_data"]
    assert next(p for p in payload if p["type"] == "input_file")["filename"] == "file.pdf"
    assert payload[-1] == {"type": "input_text", "text": "actual text"}
    assert service.sources == []
    assert model_inputs([ConversationTurn(role="user", content="plain")], {}) == [{"role": "user", "content": "plain"}]
    await service.close()
