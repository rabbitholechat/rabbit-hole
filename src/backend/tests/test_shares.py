from copy import deepcopy

from fastapi.testclient import TestClient
from test_history import MemoryHistory, session

from rabbit_hole.app import create_app
from rabbit_hole.config import Settings
from rabbit_hole.history import HistoryNotFound, public_snapshot


class MemoryShares(MemoryHistory):
    def __init__(self):
        super().__init__()
        self.shares = {}

    def create_share(self, value):
        key = f"snapshot-{len(self.shares)}"
        self.shares[key] = public_snapshot(value)
        return {"id": key}

    def get_share(self, key):
        if key not in self.shares:
            raise HistoryNotFound()
        return {"session": deepcopy(self.shares[key])}


def test_share_contract_snapshot_survives_original_edits_and_deletion_without_models():
    def no_model(*args):
        raise AssertionError("Sharing must not instantiate model services")

    repository = MemoryShares()
    client = TestClient(create_app(Settings(_env_file=None), no_model, repository))
    original = session()
    original["nodes"][0]["data"]["continuation"] = "private-context"
    original["lastNodeContext"] = {"text": "private request context"}
    client.put("/api/sessions/shared-session", json={"session": original, "revision": 0})
    created = client.post("/api/shares", json=original)
    assert created.status_code == 201
    key = created.json()["id"]
    client.put("/api/sessions/shared-session", json={"session": session(query="changed"), "revision": 1})
    client.delete("/api/sessions/shared-session?revision=2")
    shared = client.get(f"/api/shares/{key}")
    assert shared.status_code == 200
    assert shared.headers["cache-control"] == "no-store"
    snapshot = shared.json()["session"]
    assert snapshot["nodes"][0]["position"] == original["nodes"][0]["position"]
    assert snapshot["viewport"] == original["viewport"]
    assert snapshot["query"] == original["query"]
    assert "continuation" not in snapshot
    assert "continuation" not in snapshot["nodes"][0]["data"]
    assert "lastNodeContext" not in snapshot
    assert client.get("/api/sessions").json() == {"sessions": []}
    assert client.put(f"/api/shares/{key}", json=original).status_code == 405
    assert client.delete(f"/api/shares/{key}").status_code == 405
    assert client.get("/api/shares/missing").status_code == 404


def test_share_validation_limits_and_unavailable_database():
    client = TestClient(create_app(Settings(_env_file=None, max_history_bytes=10000), history_repository=MemoryShares()))
    assert client.post("/api/shares", json={"id": "invalid"}).status_code == 422
    assert client.post("/api/shares", json=session(query="x" * 10000)).status_code == 413
    original = session(status="running")
    original["nodes"][0]["data"]["status"] = "streaming"
    original["contentGraph"]["jobs"]["r"] = {"status": "running", "attemptId": "job"}
    key = client.post("/api/shares", json=original).json()["id"]
    shared = client.get(f"/api/shares/{key}").json()["session"]
    assert shared["status"] == "partial"
    assert shared["nodes"][0]["data"]["status"] == "partial"
    assert shared["contentGraph"]["jobs"]["r"]["status"] == "cancelled"
    unavailable = TestClient(create_app(Settings(_env_file=None, database_url="")))
    assert unavailable.post("/api/shares", json=session()).status_code == 503
    assert unavailable.get("/api/shares/missing").status_code == 503
