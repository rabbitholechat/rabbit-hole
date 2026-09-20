"""Shared review history. No model calls, browser identity, or process-local persistence."""

import json
import logging
import secrets
from contextlib import contextmanager
from typing import Annotated, Literal

import psycopg
from fastapi import APIRouter, HTTPException, Path, Query, Response
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from pydantic import BaseModel, ConfigDict, Field, JsonValue

from . import diagnostics
from .config import Settings, get_settings
from .structure import EntityKind

SessionId = Annotated[str, Field(min_length=1, max_length=128, pattern=r"^[a-zA-Z0-9_-]+$")]


class Position(BaseModel):
    x: float = Field(allow_inf_nan=False)
    y: float = Field(allow_inf_nan=False)


class Viewport(Position):
    zoom: float = Field(gt=0, allow_inf_nan=False)


class CanvasNode(BaseModel):
    model_config = ConfigDict(extra="allow")
    id: str
    type: Literal["page", "response", "information", "source", "entity", "attachment"]
    position: Position
    data: dict[str, JsonValue]


class UserNodeData(BaseModel):
    kind: Literal["response", "entity", "information", "source", "image"]
    title: str
    text: str
    url: str
    imageUrl: str
    label: str | None = None
    attachment: dict[str, JsonValue] | None = None
    page: dict[str, JsonValue] | None = None
    presentation: dict[str, JsonValue] | None = None
    entitySubtype: EntityKind | None = None
    qualifier: str | None = None
    aliases: list[str] | None = None
    collapsed: bool | None = None


class UserNode(BaseModel):
    model_config = ConfigDict(extra="allow")
    id: str
    type: Literal["user"]
    position: Position
    data: UserNodeData


class UserEdge(BaseModel):
    sourceHandle: str | None = None
    targetHandle: str | None = None
    id: str
    source: str
    target: str
    label: str


class CanvasEdits(BaseModel):
    nodes: list[UserNode]
    hiddenNodes: list[str]
    edges: list[UserEdge]
    hiddenEdges: list[str]
    positions: dict[str, Position]


class ResponseTiming(BaseModel):
    responseId: str | None = None
    startedAt: int = Field(ge=0, le=9_007_199_254_740_991)
    durationMs: int | None = Field(default=None, ge=0, le=9_007_199_254_740_991)
    status: Literal["running", "completed", "failed", "cancelled", "interrupted"]


class HistorySession(BaseModel):
    # Preserve legacy and future canvas fields without altering their original values.
    model_config = ConfigDict(extra="allow")
    id: SessionId
    query: str
    title: str | None = None
    titleRequested: bool | None = None
    lastParentId: str | None = None
    lastQuery: str | None = None
    lastNodeContext: dict[str, JsonValue] | None = None
    responseTimings: dict[str, ResponseTiming] | None = None
    canvasEdits: CanvasEdits | None = None
    updatedAt: int = Field(ge=0, le=9_007_199_254_740_991)
    mode: Literal["live", "sample"]
    protocol: Literal[2] | None = None
    sources: list[dict[str, JsonValue]]
    nodes: list[CanvasNode]
    graph: dict[str, JsonValue]
    contentGraph: dict[str, JsonValue] | None = None
    answer: dict[str, JsonValue] | None
    viewport: Viewport
    fitted: bool
    pinned: list[str]
    continuation: str | None = None
    status: Literal["idle", "running", "completed", "partial", "failed", "cancelled", "awaiting_input"]
    failedParts: list[str]


class SessionWrite(BaseModel):
    model_config = ConfigDict(extra="forbid")
    session: HistorySession
    revision: int = Field(ge=0)


class StoredSession(SessionWrite):
    revision: int = Field(ge=1)


class HistoryList(BaseModel):
    sessions: list[StoredSession]
    next_cursor: SessionId | None = None


class Revision(BaseModel):
    revision: int = Field(ge=1)


class ImportResult(BaseModel):
    imported: bool


class HistoryConflict(Exception):
    pass


class HistoryNotFound(Exception):
    pass


class HistoryUnavailable(Exception):
    pass


class HistoryRepository:
    def __init__(self, settings: Settings):
        self.url = settings.database_url.get_secret_value()

    @contextmanager
    def connection(self):
        if not self.url:
            raise HistoryUnavailable()
        try:
            # Short-lived connections also work behind a transaction-pooling proxy.
            with psycopg.connect(self.url, connect_timeout=5, prepare_threshold=None, row_factory=dict_row) as conn:
                conn.execute("SELECT set_config('statement_timeout', '10000', true)")
                yield conn
        except psycopg.Error:
            # Never expose connection strings, SQL parameters, or stored conversation text.
            diagnostics.log(logging.ERROR, "history", "storage_failed", code="database_unavailable", location="history")
            raise HistoryUnavailable() from None

    def initialize(self):
        from .attachments import initialize_attachments
        with self.connection() as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS rabbit_hole_sessions (
                    id varchar(128) PRIMARY KEY,
                    payload jsonb,
                    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
                    updated_at bigint NOT NULL,
                    deleted boolean NOT NULL DEFAULT false,
                    CHECK ((deleted AND payload IS NULL) OR (NOT deleted AND payload IS NOT NULL))
                )
            """)
            conn.execute("""
                CREATE INDEX IF NOT EXISTS rabbit_hole_sessions_updated
                ON rabbit_hole_sessions (updated_at DESC, id) WHERE NOT deleted
            """)

            initialize_attachments(conn)
            conn.execute("""CREATE TABLE IF NOT EXISTS rabbit_hole_shares (
                id varchar(64) PRIMARY KEY, payload jsonb NOT NULL,
                created_at timestamptz NOT NULL DEFAULT now()
            )""")
            conn.execute("""CREATE TABLE IF NOT EXISTS rabbit_hole_share_attachment_refs (
                attachment_id uuid REFERENCES rabbit_hole_attachments(id) ON DELETE CASCADE,
                share_id varchar(64) REFERENCES rabbit_hole_shares(id) ON DELETE CASCADE,
                PRIMARY KEY (attachment_id, share_id)
            )""")

    def create_share(self, session: HistorySession):
        from uuid import UUID

        from .attachments import AttachmentFailure

        share_id = secrets.token_urlsafe(24)
        payload = public_snapshot(session)
        ids = set()
        def collect(value):
            if isinstance(value, dict):
                attachment = value.get("attachment")
                if isinstance(attachment, dict) and attachment.get("id"):
                    try:
                        ids.add(UUID(attachment["id"]))
                    except (ValueError, TypeError):
                        raise AttachmentFailure("첨부 기록이 올바르지 않습니다.") from None
                for child in value.values():
                    collect(child)
            elif isinstance(value, list):
                for child in value:
                    collect(child)
        collect(payload)
        with self.connection() as conn:
            if ids:
                found = conn.execute("SELECT id FROM rabbit_hole_attachments WHERE id = ANY(%s) ORDER BY id FOR UPDATE", (list(ids),)).fetchall()
                if len(found) != len(ids):
                    raise AttachmentFailure("첨부 자료가 만료되었거나 삭제되었습니다.", 409)
            conn.execute("INSERT INTO rabbit_hole_shares (id, payload) VALUES (%s, %s)", (share_id, Jsonb(payload)))
            if ids:
                with conn.cursor() as cursor:
                    cursor.executemany("INSERT INTO rabbit_hole_share_attachment_refs (attachment_id, share_id) VALUES (%s, %s)", [(key, share_id) for key in ids])
        return {"id": share_id}

    def get_share(self, share_id: str):
        with self.connection() as conn:
            row = conn.execute("SELECT payload AS session FROM rabbit_hole_shares WHERE id = %s", (share_id,)).fetchone()
        if row is None:
            raise HistoryNotFound()
        return row

    def list(self, cursor: str = ""):
        with self.connection() as conn:
            rows = conn.execute("""
                SELECT id, payload AS session, revision FROM rabbit_hole_sessions
                WHERE NOT deleted AND id > %s ORDER BY id LIMIT 21
            """, (cursor,)).fetchall()
        page = []
        size = 0
        for row in rows[:20]:
            record = {"session": row["session"], "revision": row["revision"]}
            record_size = len(json.dumps(record, ensure_ascii=False, separators=(",", ":")).encode())
            # Bound each response below the Vercel function payload limit.
            if page and size + record_size > 4_000_000:
                break
            page.append(record)
            size += record_size
        result = {"sessions": page}
        if len(rows) > len(page):
            result["next_cursor"] = rows[len(page) - 1]["id"]
        return result

    def get(self, session_id: str):
        with self.connection() as conn:
            row = conn.execute("""
                SELECT payload AS session, revision FROM rabbit_hole_sessions
                WHERE id = %s AND NOT deleted
            """, (session_id,)).fetchone()
        if row is None:
            raise HistoryNotFound()
        return row

    def save(self, session: HistorySession, revision: int):
        from .attachments import sync_attachment_refs
        payload = Jsonb(session.model_dump(exclude_unset=True))
        with self.connection() as conn:
            if revision == 0:
                row = conn.execute("""
                    INSERT INTO rabbit_hole_sessions (id, payload, updated_at)
                    VALUES (%s, %s, %s) ON CONFLICT (id) DO NOTHING RETURNING revision
                """, (session.id, payload, session.updatedAt)).fetchone()
            else:
                row = conn.execute("""
                    UPDATE rabbit_hole_sessions SET payload = %s, updated_at = %s, revision = revision + 1
                    WHERE id = %s AND revision = %s AND NOT deleted RETURNING revision
                """, (payload, session.updatedAt, session.id, revision)).fetchone()
            if not row:
                raise HistoryConflict()
            sync_attachment_refs(conn, session)
        return row

    def import_session(self, session: HistorySession):
        from .attachments import sync_attachment_refs
        with self.connection() as conn:
            row = conn.execute("""
                INSERT INTO rabbit_hole_sessions (id, payload, updated_at)
                VALUES (%s, %s, %s) ON CONFLICT (id) DO NOTHING RETURNING id
            """, (session.id, Jsonb(session.model_dump(exclude_unset=True)), session.updatedAt)).fetchone()
            if row:
                sync_attachment_refs(conn, session)
        return {"imported": row is not None}

    def delete(self, session_id: str, revision: int):
        with self.connection() as conn:
            row = conn.execute("""
                UPDATE rabbit_hole_sessions SET deleted = true, payload = NULL, revision = revision + 1
                WHERE id = %s AND revision = %s AND NOT deleted RETURNING id
            """, (session_id, revision)).fetchone()
            if not row:
                raise HistoryConflict()
            ids = conn.execute("DELETE FROM rabbit_hole_attachment_refs WHERE session_id = %s RETURNING attachment_id", (session_id,)).fetchall()
            if ids:
                conn.execute("""DELETE FROM rabbit_hole_attachments a WHERE a.id = ANY(%s)
                    AND NOT EXISTS (SELECT 1 FROM rabbit_hole_attachment_refs r WHERE r.attachment_id = a.id)
                    AND NOT EXISTS (SELECT 1 FROM rabbit_hole_share_attachment_refs r WHERE r.attachment_id = a.id)""",
                    ([row["attachment_id"] for row in ids],))
        # Keep only an ID tombstone so another tab or a legacy import cannot resurrect a deletion.


class ShareCreated(BaseModel):
    id: str


class SharedCanvas(BaseModel):
    session: HistorySession


def public_snapshot(session: HistorySession):
    # Public canvas only: never distribute signed continuation/model context.
    payload = session.model_dump(exclude_unset=True)
    for key in ("continuation", "lastNodeContext", "lastAttachments", "readOnly"):
        payload.pop(key, None)
    for node in payload["nodes"]:
        node["data"].pop("continuation", None)
        if node["type"] == "response" and node["data"].get("status") == "streaming":
            node["data"]["status"] = "partial"
    if payload["status"] == "running":
        payload["status"] = "partial"
    for job in (payload.get("contentGraph") or {}).get("jobs", {}).values():
        if job.get("status") == "running":
            job["status"] = "cancelled"
    for timing in (payload.get("responseTimings") or {}).values():
        if timing.get("status") == "running":
            timing["status"] = "interrupted"
    return payload


def share_router(repository: HistoryRepository):
    router = APIRouter(prefix="/api/shares", tags=["shared canvas"])

    @router.post("", response_model=ShareCreated, status_code=201)
    def create_share(body: HistorySession):
        try:
            return repository.create_share(body)
        except HistoryUnavailable:
            raise HTTPException(503, "공유 저장소에 연결할 수 없습니다.") from None

    @router.get("/{share_id}", response_model=SharedCanvas, response_model_exclude_unset=True)
    def get_share(response: Response, share_id: SessionId = Path()):
        response.headers["Cache-Control"] = "no-store"
        try:
            return repository.get_share(share_id)
        except HistoryNotFound:
            raise HTTPException(404, "공유 캔버스를 찾을 수 없습니다.") from None
        except HistoryUnavailable:
            raise HTTPException(503, "공유 저장소에 연결할 수 없습니다.") from None

    return router


def history_router(repository: HistoryRepository):
    router = APIRouter(prefix="/api/sessions", tags=["shared history"])

    @contextmanager
    def operation():
        try:
            yield
        except HistoryConflict:
            raise HTTPException(409, "기록이 다른 화면에서 변경되거나 삭제되었습니다. 새로고침 후 다시 시도하세요.") from None
        except HistoryNotFound:
            raise HTTPException(404, "기록을 찾을 수 없습니다.") from None
        except HistoryUnavailable:
            raise HTTPException(503, "기록 데이터베이스에 연결할 수 없습니다.") from None

    @router.get("", response_model=HistoryList, response_model_exclude_unset=True)
    def list_sessions(response: Response, cursor: SessionId | None = Query(default=None)):
        response.headers["Cache-Control"] = "no-store"
        with operation():
            return repository.list(cursor or "")

    @router.get("/{session_id}", response_model=StoredSession, response_model_exclude_unset=True)
    def get_session(response: Response, session_id: SessionId = Path()):
        response.headers["Cache-Control"] = "no-store"
        with operation():
            return repository.get(session_id)

    @router.put("/{session_id}", response_model=Revision)
    def save_session(body: SessionWrite, session_id: SessionId = Path()):
        if body.session.id != session_id:
            raise HTTPException(422, "기록 ID가 일치하지 않습니다.")
        with operation():
            return repository.save(body.session, body.revision)

    @router.post("/{session_id}/import", response_model=ImportResult)
    def import_session(body: HistorySession, session_id: SessionId = Path()):
        if body.id != session_id:
            raise HTTPException(422, "기록 ID가 일치하지 않습니다.")
        with operation():
            return repository.import_session(body)

    @router.delete("/{session_id}", status_code=204)
    def delete_session(session_id: SessionId = Path(), revision: int = Query(ge=1)):
        with operation():
            repository.delete(session_id, revision)

    return router


if __name__ == "__main__":
    try:
        HistoryRepository(get_settings()).initialize()
    except HistoryUnavailable:
        raise SystemExit("Database initialization failed. Check DATABASE_URL and database availability.") from None
    print("History database schema initialized.")
