"""Explicit integration suite: TEST_DATABASE_URL must point to a test PostgreSQL server.

Every test creates and drops only its own random schema; no existing table is touched.
"""

import os
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg import sql
from psycopg.conninfo import make_conninfo
from test_history import session

from rabbit_hole.app import create_app
from rabbit_hole.config import Settings
from rabbit_hole.history import HistoryConflict, HistoryRepository, HistorySession

pytestmark = pytest.mark.skipif(not os.environ.get("TEST_DATABASE_URL"), reason="Explicit TEST_DATABASE_URL required")


@pytest.fixture
def settings():
    url = os.environ["TEST_DATABASE_URL"]
    schema = "history_test_" + uuid4().hex
    with psycopg.connect(url) as conn:
        conn.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
    settings = Settings(_env_file=None, database_url=make_conninfo(url, options=f"-c search_path={schema}"), openai_api_key="")
    repository = HistoryRepository(settings)
    repository.initialize()
    repository.initialize()  # Repeatable migration.
    try:
        yield settings
    finally:
        with psycopg.connect(url) as conn:
            conn.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(schema)))


def test_postgres_survives_new_app_instances_and_preserves_complete_snapshot(settings):
    first = TestClient(create_app(settings))
    original = session()
    assert first.put("/api/sessions/shared-session", json={"session": original, "revision": 0}).json() == {"revision": 1}
    second = TestClient(create_app(settings))
    assert second.get("/api/sessions").json() == {"sessions": [{"session": original, "revision": 1}]}
    assert second.get("/api/sessions/shared-session").json() == {"session": original, "revision": 1}
    assert second.put("/api/sessions/newer", json={"session": session("newer", updatedAt=2000), "revision": 0}).status_code == 200
    assert [r["session"]["id"] for r in first.get("/api/sessions").json()["sessions"]] == ["newer", "shared-session"]
    assert second.delete("/api/sessions/shared-session?revision=1").status_code == 204
    assert first.get("/api/sessions/shared-session").status_code == 404
    assert first.put("/api/sessions/shared-session", json={"session": original, "revision": 1}).status_code == 409
    assert first.post("/api/sessions/shared-session/import", json=original).json() == {"imported": False}
    with HistoryRepository(settings).connection() as conn:
        row = conn.execute("SELECT payload, deleted FROM rabbit_hole_sessions WHERE id = %s", (original["id"],)).fetchone()
    assert row == {"payload": None, "deleted": True}


def test_postgres_concurrent_writers_are_atomic(settings):
    repository = HistoryRepository(settings)
    original = HistorySession.model_validate(session())
    repository.save(original, 0)

    def write(title):
        changed = original.model_copy(update={"title": title})
        try:
            return repository.save(changed, 1)["revision"]
        except HistoryConflict:
            return "conflict"

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(write, ["first", "second"]))
    assert results.count(2) == 1
    assert results.count("conflict") == 1
    assert repository.import_session(original) == {"imported": False}
    assert repository.list()["sessions"][0]["session"]["title"] in {"first", "second"}


def test_postgres_history_pages_bound_count_and_response_bytes(settings):
    client = TestClient(create_app(settings))
    for i in range(23):
        item = session(f"record-{i:02}")
        assert client.post(f"/api/sessions/{item['id']}/import", json=item).status_code == 200
    page = client.get("/api/sessions").json()
    assert len(page["sessions"]) == 20
    assert page["next_cursor"] == "record-19"
    last = client.get("/api/sessions", params={"cursor": page["next_cursor"]}).json()
    assert len(last["sessions"]) == 3
    assert "next_cursor" not in last
    for i in range(2):
        item = session(f"large-{i}", query="가" * 700_000)
        assert client.post(f"/api/sessions/{item['id']}/import", json=item).status_code == 200
    response = client.get("/api/sessions")
    assert len(response.content) < 4_100_000
    assert len(response.json()["sessions"]) == 1
    assert response.json()["next_cursor"] == "large-0"
