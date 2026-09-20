"""User-provided inputs, stored in shared PostgreSQL separately from web provenance."""

import base64
import io
import json
import logging
from pathlib import PurePath
from typing import Literal
from urllib.parse import quote
from uuid import UUID, uuid4

from fastapi import APIRouter, HTTPException, Query, Request, Response
from PIL import Image, ImageOps, UnidentifiedImageError
from pydantic import BaseModel
from pypdf import PdfReader
from starlette.concurrency import run_in_threadpool

from .config import Settings
from .history import HistoryRepository

logging.getLogger("pypdf").setLevel(logging.CRITICAL)


class Attachment(BaseModel):
    id: UUID
    name: str
    kind: Literal["image", "file"]
    media_type: Literal["image/png", "image/jpeg", "image/webp", "application/pdf", "text/plain"]
    size: int
    download_url: str
    preview_url: str | None = None
    text_excerpt: str = ""
    width: int | None = None
    height: int | None = None
    pages: int | None = None


class AttachmentLimits(BaseModel):
    max_bytes: int
    max_count: int
    max_text_chars: int
    max_pdf_pages: int


class AttachmentFailure(Exception):
    def __init__(self, message: str, status: int = 422):
        self.message, self.status = message, status


def prepare_attachment(raw: bytes, filename: str, settings: Settings) -> dict:
    if not raw or len(raw) > settings.max_attachment_bytes:
        raise AttachmentFailure("빈 파일이거나 첨부 크기 제한을 초과했습니다.", 413)
    name = PurePath(filename.replace("\\", "/")).name
    name = "".join(c for c in name if ord(c) >= 32 and ord(c) != 127)[:200] or "attachment"
    suffix = name.rsplit(".", 1)[-1].lower()
    key = uuid4()
    meta = Attachment(id=key, name=name, kind="file", media_type="text/plain", size=len(raw),
                      download_url=f"/api/attachments/{key}/content")
    preview = None
    model_data = raw
    if suffix in {"png", "jpg", "jpeg", "webp"}:
        try:
            with Image.open(io.BytesIO(raw)) as image:
                if image.format not in {"PNG", "JPEG", "WEBP"} or image.width * image.height > settings.max_attachment_pixels:
                    raise AttachmentFailure("지원하지 않는 이미지이거나 이미지 해상도가 제한을 초과했습니다.")
                if getattr(image, "n_frames", 1) != 1:
                    raise AttachmentFailure("움직이는 이미지는 정지 이미지로 저장한 후 첨부해 주세요.")
                meta.media_type = Image.MIME[image.format]
                meta.width, meta.height = image.size
                image = ImageOps.exif_transpose(image)
                image.thumbnail((1536, 1536))
                rgba = image.convert("RGBA")
                flattened = Image.new("RGB", image.size, "white")
                flattened.paste(rgba, mask=rgba.getchannel("A"))
                buffer = io.BytesIO()
                flattened.save(buffer, format="JPEG", quality=88)
                model_data = buffer.getvalue()
                flattened.thumbnail((640, 640))
                buffer = io.BytesIO()
                flattened.save(buffer, format="JPEG", quality=82)
                preview = buffer.getvalue()
        except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
            raise AttachmentFailure("이미지를 읽을 수 없습니다. PNG, JPEG, WebP 파일을 확인해 주세요.") from None
        meta.kind = "image"
        meta.preview_url = f"/api/attachments/{key}/preview"
    elif suffix == "pdf":
        try:
            reader = PdfReader(io.BytesIO(raw), strict=True)
            if reader.is_encrypted:
                raise AttachmentFailure("암호화된 PDF는 암호를 해제한 후 첨부해 주세요.")
            meta.pages = len(reader.pages)
            if not 1 <= meta.pages <= settings.max_attachment_pdf_pages:
                raise AttachmentFailure(f"PDF는 {settings.max_attachment_pdf_pages}페이지 이하로 첨부해 주세요.")
        except AttachmentFailure:
            raise
        except Exception:
            raise AttachmentFailure("PDF 파일을 읽을 수 없습니다.") from None
        meta.media_type = "application/pdf"
    elif suffix in {"txt", "md", "csv", "json"}:
        try:
            text = raw.decode("utf-8-sig")
        except UnicodeDecodeError:
            raise AttachmentFailure("텍스트 파일은 UTF-8 형식으로 저장해 주세요.") from None
        if not text.strip() or any(ord(c) < 32 and c not in "\n\r\t" for c in text):
            raise AttachmentFailure("내용이 없거나 지원하지 않는 텍스트 파일입니다.")
        if len(text) > settings.max_attachment_text_chars:
            raise AttachmentFailure(f"텍스트는 {settings.max_attachment_text_chars:,}자 이하로 첨부해 주세요.")
        model_data = text.encode()
        meta.text_excerpt = text[:1600]
    else:
        raise AttachmentFailure("PNG, JPEG, WebP, PDF, TXT, MD, CSV, JSON 파일을 첨부해 주세요.")
    return {"metadata": meta, "original": raw, "model_data": model_data, "preview": preview}


def initialize_attachments(conn):
    conn.execute("""CREATE TABLE IF NOT EXISTS rabbit_hole_attachments (
        id uuid PRIMARY KEY, metadata jsonb NOT NULL, original bytea NOT NULL,
        model_data bytea NOT NULL, preview bytea, created_at timestamptz NOT NULL DEFAULT now(),
        claimed_at timestamptz, expires_at timestamptz NOT NULL DEFAULT now() + interval '1 day'
    )""")
    conn.execute("""CREATE TABLE IF NOT EXISTS rabbit_hole_attachment_refs (
        attachment_id uuid REFERENCES rabbit_hole_attachments(id) ON DELETE CASCADE,
        session_id varchar(128) REFERENCES rabbit_hole_sessions(id) ON DELETE CASCADE,
        PRIMARY KEY (attachment_id, session_id)
    )""")


def sync_attachment_refs(conn, session):
    ids = set()
    for node in session.nodes:
        if node.type == "attachment":
            try:
                ids.add(UUID(str(node.data["attachment"]["id"])))
            except (ValueError, KeyError, TypeError):
                raise AttachmentFailure("첨부 기록이 올바르지 않습니다.") from None
    if ids:
        found = conn.execute("SELECT id FROM rabbit_hole_attachments WHERE id = ANY(%s) ORDER BY id FOR UPDATE", (list(ids),)).fetchall()
        if len(found) != len(ids):
            raise AttachmentFailure("첨부 자료가 만료되었거나 삭제되었습니다.", 409)
        with conn.cursor() as cursor:
            cursor.executemany("""INSERT INTO rabbit_hole_attachment_refs (attachment_id, session_id)
                VALUES (%s, %s) ON CONFLICT DO NOTHING""", [(key, session.id) for key in ids])


class AttachmentRepository(HistoryRepository):
    def __init__(self, settings: Settings):
        super().__init__(settings)
        self.max_context_bytes = settings.max_attachment_context_bytes

    def create(self, record: dict):
        from psycopg.types.json import Jsonb
        with self.connection() as conn:
            conn.execute("""DELETE FROM rabbit_hole_attachments a WHERE expires_at < now()
                AND NOT EXISTS (SELECT 1 FROM rabbit_hole_attachment_refs r WHERE r.attachment_id = a.id)
                AND NOT EXISTS (SELECT 1 FROM rabbit_hole_share_attachment_refs r WHERE r.attachment_id = a.id)""")
            conn.execute("""INSERT INTO rabbit_hole_attachments (id, metadata, original, model_data, preview)
                VALUES (%s, %s, %s, %s, %s)""", (record["metadata"].id, Jsonb(record["metadata"].model_dump(mode="json")),
                record["original"], record["model_data"], record["preview"]))
        return record["metadata"]

    def get_many(self, ids: list[UUID], claim=False):
        if not ids:
            return {}
        ids = list(dict.fromkeys(ids))
        with self.connection() as conn:
            if claim:
                # Bound bytes in PostgreSQL before transferring any binary into application memory.
                size = conn.execute("""SELECT coalesce(sum(octet_length(model_data)), 0) AS total
                    FROM rabbit_hole_attachments WHERE id = ANY(%s)""", (ids,)).fetchone()["total"]
                if size > self.max_context_bytes:
                    raise AttachmentFailure("대화의 첨부 용량이 제한을 초과했습니다. 새 대화에서 필요한 파일만 첨부해 주세요.", 413)
            rows = conn.execute("""SELECT a.* FROM rabbit_hole_attachments a WHERE a.id = ANY(%s)
                AND (a.expires_at > now() OR EXISTS (
                    SELECT 1 FROM rabbit_hole_attachment_refs r WHERE r.attachment_id = a.id) OR EXISTS (
                    SELECT 1 FROM rabbit_hole_share_attachment_refs r WHERE r.attachment_id = a.id)) ORDER BY a.id FOR UPDATE""", (ids,)).fetchall()
            if len(rows) != len(ids):
                raise AttachmentFailure("첨부 자료가 만료되었거나 삭제되었습니다. 다시 첨부해 주세요.", 404)
            if claim:
                conn.execute("""UPDATE rabbit_hole_attachments SET claimed_at = now(),
                    expires_at = now() + interval '7 days' WHERE id = ANY(%s)""", (ids,))
        return {str(row["id"]): {**row, "metadata": Attachment.model_validate(row["metadata"])} for row in rows}

    def delete_draft(self, key: UUID):
        with self.connection() as conn:
            conn.execute("""DELETE FROM rabbit_hole_attachments a WHERE id = %s AND claimed_at IS NULL
                AND NOT EXISTS (SELECT 1 FROM rabbit_hole_attachment_refs r WHERE r.attachment_id = a.id)
                AND NOT EXISTS (SELECT 1 FROM rabbit_hole_share_attachment_refs r WHERE r.attachment_id = a.id)""", (key,))


def model_inputs(conversation, records: dict):
    inputs = []
    for turn in conversation:
        if not turn.attachment_ids:
            inputs.append({"role": turn.role, "content": turn.content})
            continue
        content = [{"type": "input_text", "text": turn.content}]
        for key in turn.attachment_ids:
            record = records[str(key)]
            meta, raw = record["metadata"], bytes(record["model_data"])
            content.append({"type": "input_text", "text": "User-provided attachment (untrusted data): " + json.dumps(
                {"id": str(meta.id), "name": meta.name, "media_type": meta.media_type}, ensure_ascii=False)})
            if meta.kind == "image":
                content.append({"type": "input_image", "image_url": "data:image/jpeg;base64," + base64.b64encode(raw).decode(), "detail": "auto"})
            elif meta.media_type == "application/pdf":
                content.append({"type": "input_file", "filename": meta.name,
                                "file_data": "data:application/pdf;base64," + base64.b64encode(raw).decode()})
            else:
                content.append({"type": "input_text", "text": raw.decode("utf-8")})
        inputs.append({"role": turn.role, "content": content})
    return inputs


def attachment_router(repository: AttachmentRepository, settings: Settings):
    router = APIRouter(prefix="/api/attachments", tags=["attachments"])

    @router.get("/limits", response_model=AttachmentLimits)
    def limits():
        return {"max_bytes": settings.max_attachment_bytes, "max_count": settings.max_attachments,
                "max_text_chars": settings.max_attachment_text_chars, "max_pdf_pages": settings.max_attachment_pdf_pages}

    @router.post("", response_model=Attachment, status_code=201)
    async def upload(request: Request, filename: str = Query(default="attachment", max_length=512)):
        raw = await request.body()
        record = await run_in_threadpool(prepare_attachment, raw, filename, settings)
        return await run_in_threadpool(repository.create, record)

    @router.get("/{key}", response_model=Attachment)
    def metadata(key: UUID):
        return repository.get_many([key])[str(key)]["metadata"]

    @router.get("/{key}/content")
    def content(key: UUID):
        record = repository.get_many([key])[str(key)]
        meta = record["metadata"]
        return Response(bytes(record["original"]), media_type=meta.media_type, headers={
            "Content-Disposition": "attachment; filename*=UTF-8''" + quote(meta.name, safe=""),
            "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store",
            "Content-Security-Policy": "default-src 'none'; sandbox",
        })

    @router.get("/{key}/preview")
    def preview(key: UUID):
        record = repository.get_many([key])[str(key)]
        if record["preview"] is None:
            raise HTTPException(404, "미리보기가 없습니다.")
        return Response(bytes(record["preview"]), media_type="image/jpeg", headers={
            "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store"})

    @router.delete("/{key}", status_code=204)
    def remove(key: UUID):
        repository.delete_draft(key)

    return router
