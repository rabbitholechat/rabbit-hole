from copy import deepcopy

import psycopg
from fastapi.testclient import TestClient

from rabbit_hole.app import create_app
from rabbit_hole.config import Settings
from rabbit_hole.history import HistoryConflict, HistoryNotFound


def session(session_id="shared-session", **changes):
    return {
        "id": session_id, "query": "공용 기록", "updatedAt": 1000, "mode": "live", "protocol": 2,
        "sources": [], "nodes": [{"id": "r", "type": "response", "position": {"x": -123, "y": 45},
                                    "data": {"prompt": "질문", "text": "공개 답변", "status": "completed"}}],
        "graph": {"relations": [], "clusters": []}, "answer": None,
        "viewport": {"x": 123, "y": -45, "zoom": 0.8}, "fitted": True, "pinned": ["r"],
        "status": "completed", "failedParts": [], "continuation": "signed-context",
        "contentGraph": {"version": 1, "entities": {}, "relations": [], "jobs": {}}, **changes,
    }


class MemoryHistory:
    def __init__(self):
        self.rows = {}
        self.deleted = set()

    def list(self, cursor=""):
        return {"sessions": sorted(deepcopy(list(self.rows.values())), key=lambda r: -r["session"]["updatedAt"])}

    def get(self, session_id):
        if session_id not in self.rows:
            raise HistoryNotFound()
        return deepcopy(self.rows[session_id])

    def save(self, session, revision):
        if session.id in self.deleted or self.rows.get(session.id, {}).get("revision", 0) != revision:
            raise HistoryConflict()
        self.rows[session.id] = {"session": session.model_dump(exclude_unset=True), "revision": revision + 1}
        return {"revision": revision + 1}

    def import_session(self, session):
        if session.id in self.rows or session.id in self.deleted:
            return {"imported": False}
        self.save(session, 0)
        return {"imported": True}

    def delete(self, session_id, revision):
        if self.rows.get(session_id, {}).get("revision") != revision:
            raise HistoryConflict()
        del self.rows[session_id]
        self.deleted.add(session_id)


def test_shared_history_contract_without_model_calls():
    def no_model(*args):
        raise AssertionError("History must never instantiate a model service")

    repository = MemoryHistory()
    settings = Settings(_env_file=None, database_url="", openai_api_key="")
    first = TestClient(create_app(settings, no_model, repository))
    second = TestClient(create_app(settings, no_model, repository))
    original = session()
    assert first.put("/api/sessions/shared-session", json={"session": original, "revision": 0}).json() == {"revision": 1}
    response = second.get("/api/sessions")
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {"sessions": [{"session": original, "revision": 1}]}
    detail = second.get("/api/sessions/shared-session")
    assert detail.headers["cache-control"] == "no-store"
    assert detail.json() == {"session": original, "revision": 1}
    changed = session(title="다른 브라우저")
    assert second.put("/api/sessions/shared-session", json={"session": changed, "revision": 1}).json() == {"revision": 2}
    assert first.put("/api/sessions/shared-session", json={"session": original, "revision": 1}).status_code == 409
    assert first.delete("/api/sessions/shared-session?revision=1").status_code == 409
    assert second.delete("/api/sessions/shared-session?revision=2").status_code == 204
    assert first.get("/api/sessions").json() == {"sessions": []}
    assert first.get("/api/sessions/shared-session").status_code == 404
    assert first.post("/api/sessions/shared-session/import", json=original).json() == {"imported": False}
    assert first.put("/api/sessions/shared-session", json={"session": original, "revision": 0}).status_code == 409


def test_migration_is_idempotent_and_never_overwrites_newer_history():
    client = TestClient(create_app(Settings(_env_file=None), history_repository=MemoryHistory()))
    assert client.post("/api/sessions/shared-session/import", json=session()).json() == {"imported": True}
    assert client.post("/api/sessions/shared-session/import", json=session(query="old")).json() == {"imported": False}
    assert client.get("/api/sessions").json()["sessions"][0]["session"]["query"] == "공용 기록"


def test_response_timings_round_trip_and_validate_without_model_calls():
    client = TestClient(create_app(Settings(_env_file=None), history_repository=MemoryHistory()))
    timings = {
        "request-1": {"responseId": "r", "startedAt": 1000, "durationMs": 12500, "status": "completed"},
        "request-2": {"startedAt": 20000, "status": "running"},
    }
    original = session(responseTimings=timings)
    assert client.put("/api/sessions/shared-session", json={"session": original, "revision": 0}).status_code == 200
    assert client.get("/api/sessions/shared-session").json()["session"]["responseTimings"] == timings
    timings["request-1"]["durationMs"] = -1
    assert client.put("/api/sessions/shared-session", json={"session": original, "revision": 1}).status_code == 422


def test_validation_and_separate_history_body_limit():
    client = TestClient(create_app(Settings(_env_file=None, max_history_bytes=10000), history_repository=MemoryHistory()))
    assert client.put("/api/sessions/other", json={"session": session(), "revision": 0}).status_code == 422
    assert client.put("/api/sessions/shared-session", json={"session": {"id": "shared-session"}, "revision": 0}).status_code == 422
    assert client.put("/api/sessions/shared-session", json={"session": session(), "revision": -1}).status_code == 422
    assert client.delete("/api/sessions/shared-session").status_code == 422
    assert client.post("/api/sessions/other/import", json=session()).status_code == 422
    for method, path, body in [
        (client.put, "/api/sessions/shared-session", {"session": session(query="x" * 10000), "revision": 0}),
        (client.post, "/api/sessions/shared-session/import", session(query="x" * 10000)),
    ]:
        assert method(path, json=body).status_code == 413
    assert client.put("/api/sessions/shared-session", json={"session": session(), "revision": 0}).status_code == 200


def test_database_failures_are_sanitized_and_never_fall_back(monkeypatch, caplog):
    client = TestClient(create_app(Settings(_env_file=None, database_url="", openai_api_key="")))
    assert client.get("/api/sessions").status_code == 503

    def broken(*args, **kwargs):
        raise psycopg.OperationalError("SECRET_CONNECTION_PASSWORD and raw question")

    monkeypatch.setattr(psycopg, "connect", broken)
    client = TestClient(create_app(Settings(_env_file=None, database_url="postgresql://unused")))
    response = client.put("/api/sessions/shared-session", json={"session": session(), "revision": 0})
    assert response.status_code == 503
    assert "SECRET_CONNECTION_PASSWORD" not in response.text + caplog.text
    assert "raw question" not in response.text + caplog.text


def test_database_url_uses_backend_env_file_and_vercel_environment(tmp_path, monkeypatch):
    path = tmp_path / ".env"
    path.write_text("DATABASE_URL=postgresql://local-example/db\n")
    monkeypatch.delenv("DATABASE_URL", raising=False)
    assert Settings(_env_file=path).database_url.get_secret_value() == "postgresql://local-example/db"
    monkeypatch.setenv("DATABASE_URL", "postgresql://deployment-example/db")
    configured = Settings(_env_file=path)
    assert configured.database_url.get_secret_value() == "postgresql://deployment-example/db"
    assert "deployment-example" not in repr(configured.database_url)


def test_canvas_edits_contract_preserves_originals_and_validates_types():
    client = TestClient(create_app(Settings(_env_file=None), history_repository=MemoryHistory()))
    edits = {
        "nodes": [{"id": "r", "type": "user", "position": {"x": 1, "y": 2}, "width": 460,
                   "data": {"kind": "source", "title": "편집 제목", "text": "사용자 요약",
                            "url": "https://example.com/page", "imageUrl": ""}}],
        "hiddenNodes": ["removed"], "hiddenEdges": ["old-edge"],
        "edges": [{"id": "edge", "source": "r", "target": "other", "label": "사용자 연결"}],
        "positions": {"r": {"x": 123, "y": 456}},
    }
    original = session(canvasEdits=edits)
    assert client.put("/api/sessions/shared-session", json={"session": original, "revision": 0}).status_code == 200
    assert client.get("/api/sessions/shared-session").json()["session"] == original
    invalid = deepcopy(original)
    invalid["canvasEdits"]["nodes"][0]["data"]["kind"] = "verified_source"
    assert client.put("/api/sessions/shared-session", json={"session": invalid, "revision": 1}).status_code == 422


def test_copied_display_and_connection_handles_round_trip():
    client = TestClient(create_app(Settings(_env_file=None), history_repository=MemoryHistory()))
    edits = {
        "nodes": [{"id": "copy", "type": "user", "position": {"x": 500, "y": 200}, "width": 560,
                   "data": {"kind": "information", "title": "제목", "text": "내용", "url": "", "imageUrl": "",
                            "label": "개념", "collapsed": True, "entitySubtype": "concept", "qualifier": None,
                            "aliases": [], "presentation": {"heading": "제목", "summary": None, "sections": [],
                                                              "table": None}}}],
        "hiddenNodes": [], "hiddenEdges": [], "positions": {},
        "edges": [{"id": "manual", "source": "r", "target": "copy", "label": "사용자 연결",
                   "sourceHandle": "attachment-output", "targetHandle": None}],
    }
    original = session(canvasEdits=edits)
    assert client.put("/api/sessions/shared-session", json={"session": original, "revision": 0}).status_code == 200
    assert client.get("/api/sessions/shared-session").json()["session"] == original
