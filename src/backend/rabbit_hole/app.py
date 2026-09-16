import asyncio
import contextlib
import json
import os
import re
import secrets
import time
from collections import defaultdict, deque
from dataclasses import dataclass, field

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import StreamingResponse

from .config import Settings, get_settings
from .middleware import BodyLimitMiddleware
from .models import SearchRequest, Snapshot
from .search import AgentService, Budget
from .security import SnapshotSigner
from .sources import Registry


@dataclass
class Job:
    id: str = field(default_factory=lambda: secrets.token_urlsafe(24))
    token: str = field(default_factory=lambda: secrets.token_urlsafe(32))
    created: float = field(default_factory=time.monotonic)
    cancel: asyncio.Event = field(default_factory=asyncio.Event)
    task: asyncio.Task | None = None
    finished: bool = False


class JobStore:
    """Single-process active job controls. Completed data belongs in IndexedDB."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.jobs: dict[str, Job] = {}
        self.requests: dict[str, deque] = defaultdict(deque)

    def create(self, client: str) -> Job:
        now = time.monotonic()
        self.jobs = {
            k: j
            for k, j in self.jobs.items()
            if not j.finished or now - j.created < self.settings.job_ttl_seconds
        }
        self.requests = defaultdict(
            deque,
            {
                k: deque(t for t in v if now - t < 60)
                for k, v in self.requests.items()
                if v and now - v[-1] < 60
            },
        )
        timestamps = self.requests[client]
        if len(timestamps) >= self.settings.requests_per_minute:
            raise HTTPException(429, "잠시 후 다시 검색하세요.", headers={"Retry-After": "60"})
        if sum(not j.finished for j in self.jobs.values()) >= self.settings.max_concurrent_jobs:
            raise HTTPException(429, "검색 작업이 많습니다. 잠시 후 다시 시도하세요.")
        timestamps.append(now)
        if len(self.jobs) >= self.settings.max_stored_jobs:
            finished = [j for j in self.jobs.values() if j.finished]
            if finished:
                del self.jobs[min(finished, key=lambda j: j.created).id]
            else:
                raise HTTPException(429, "검색 작업 저장소가 가득 찼습니다.")
        job = Job()
        self.jobs[job.id] = job
        return job


def create_app(settings: Settings | None = None, service_factory=AgentService) -> FastAPI:
    settings = settings or get_settings()
    if os.environ.get("VERCEL") and len(settings.session_signing_key.get_secret_value()) < 32:
        raise RuntimeError("SESSION_SIGNING_KEY must contain at least 32 characters on Vercel")
    app = FastAPI(title="Rabbit Hole", version="0.1.0")
    app.add_middleware(BodyLimitMiddleware, max_bytes=settings.max_request_bytes)
    store = JobStore(settings)
    signer = SnapshotSigner(settings.session_signing_key.get_secret_value())
    app.state.store = store

    @app.get("/api/health")
    async def health():
        return {"status": "ok", "configured": settings.configured, "api_version": 1}

    @app.post(
        "/api/search",
        response_class=StreamingResponse,
        responses={
            200: {
                "description": "Versioned SSE envelopes; see docs/API.md",
                "content": {"text/event-stream": {"schema": {"type": "string"}}},
            },
            409: {"description": "Expired or invalid continuation; start a new search"},
            413: {"description": "Request body exceeds configured byte limit"},
            429: {"description": "Rate or concurrent job limit"},
            503: {"description": "Search provider configuration is missing"},
        },
    )
    async def search(body: SearchRequest, request: Request):
        snapshot = None
        if body.continuation:
            try:
                snapshot = signer.verify(body.continuation)
            except ValueError as error:
                raise HTTPException(409, str(error)) from error
        if body.focus_source_id and (
            not snapshot or body.focus_source_id not in {s.id for s in snapshot.sources}
        ):
            raise HTTPException(422, "등록된 출처를 선택하세요.")
        if snapshot and len(snapshot.sources) >= settings.max_session_sources and not body.retry_part:
            raise HTTPException(409, "이 지도의 탐색 한도에 도달했습니다. 새 검색으로 이어가세요.")
        if snapshot and not body.flight:
            body.flight = snapshot.flight
        needs_flight = bool(re.search(r"항공|비행기|flight|airfare", body.query, re.I)) and not body.flight
        if not needs_flight and not settings.configured:
            raise HTTPException(
                503,
                "검색 API가 설정되지 않았습니다. 백엔드 .env의 키를 설정하세요. 디자인 예시는 별도로 열 수 있습니다.",
            )
        # Ignore spoofable forwarding headers. Configure global per-IP limits at deployment WAF.
        job = store.create(request.client.host if request.client else "unknown")
        queue: asyncio.Queue = asyncio.Queue()
        seq = 0
        registry = Registry(snapshot.sources if snapshot else [])
        original_query = snapshot.query if snapshot else body.query
        budget = Budget(settings, cancelled=job.cancel)

        async def emit(kind: str, data: dict):
            nonlocal seq
            budget.check()
            seq += 1
            envelope = {
                "version": 1,
                "request_id": str(body.request_id),
                "job_id": job.id,
                "seq": seq,
                "type": kind,
                "data": data,
            }
            await queue.put(f"id: {seq}\nevent: {kind}\ndata: {json.dumps(envelope, ensure_ascii=False)}\n\n")
            if kind == "sources":
                checkpoint = Snapshot(
                    query=original_query,
                    sources=list(registry.sources.values()),
                    answer=snapshot.answer if snapshot else None,
                    relationships=snapshot.relationships if snapshot else None,
                    flight=body.flight,
                    issued_at=time.time(),
                )
                await emit("checkpoint", {"continuation": signer.sign(checkpoint)})

        async def produce():
            failed = []
            answer = snapshot.answer if snapshot else None
            graph = snapshot.relationships if snapshot else None
            service = None
            active_part = "search"
            try:
                await emit("started", {"access_token": job.token, "status": "running"})
                if needs_flight:
                    await emit(
                        "clarification",
                        {
                            "kind": "flight",
                            "message": "같은 조건으로 비교할 수 있도록 여행 조건을 알려주세요.",
                        },
                    )
                    await emit("done", {"status": "completed", "failed_parts": []})
                    return
                if snapshot:
                    await emit("sources", {"sources": [s.model_dump() for s in registry.sources.values()]})
                service = service_factory(settings, registry, budget, emit)
                service.previous_answer = answer
                async with asyncio.timeout(settings.job_timeout_seconds):
                    if body.retry_part != "relationships":
                        active_part = "answer"
                        try:
                            answer = await service.answer(body, original_query, search=not body.retry_part)
                            await emit("answer", answer.model_dump())
                        except asyncio.CancelledError:
                            raise
                        except Exception:
                            failed.append("answer")
                            await emit(
                                "part_error",
                                {
                                    "part": "answer",
                                    "message": "답변을 확인하지 못했습니다. 확보한 페이지는 계속 탐색할 수 있습니다.",
                                },
                            )
                    if not registry.sources:
                        failed.append("search")
                        await emit(
                            "part_error",
                            {
                                "part": "search",
                                "message": "조건에 맞는 공개 페이지를 확보하지 못했습니다. 질문을 바꿔 다시 검색하세요.",
                            },
                        )
                    if body.retry_part != "answer" and registry.sources:
                        active_part = "relationships"
                        try:
                            graph = await service.relationships()
                            await emit("relationships", graph.model_dump())
                        except asyncio.CancelledError:
                            raise
                        except Exception:
                            failed.append("relationships")
                            await emit(
                                "part_error",
                                {
                                    "part": "relationships",
                                    "message": "관계 정리를 완료하지 못했습니다. 페이지 카드는 보존했습니다.",
                                },
                            )
            except TimeoutError:
                failed.append(active_part)
                await emit(
                    "part_error",
                    {
                        "part": active_part,
                        "message": "작업 시간이 초과되었습니다. 확보한 결과는 보존했습니다.",
                    },
                )
                if active_part == "answer" and not body.retry_part and registry.sources:
                    failed.append("relationships")
                    await emit(
                        "part_error",
                        {
                            "part": "relationships",
                            "message": "시간 제한으로 관계 정리를 시작하지 못했습니다. 이 부분만 재시도할 수 있습니다.",
                        },
                    )
            except asyncio.CancelledError:
                job.cancel.set()
                raise
            finally:
                try:
                    if not job.cancel.is_set() and not needs_flight:
                        state = Snapshot(
                            query=original_query,
                            sources=list(registry.sources.values()),
                            answer=answer,
                            relationships=graph,
                            flight=body.flight,
                            issued_at=time.time(),
                        )
                        await emit("checkpoint", {"continuation": signer.sign(state)})
                        await emit(
                            "done",
                            {
                                "status": ("partial" if registry.sources else "failed")
                                if failed
                                else "completed",
                                "failed_parts": list(dict.fromkeys(failed)),
                            },
                        )
                finally:
                    job.finished = True
                    await queue.put(None)
                    if service:
                        await service.close()

        async def stream():
            job.task = asyncio.create_task(produce())
            try:
                while True:
                    try:
                        event = await asyncio.wait_for(queue.get(), timeout=5)
                    except TimeoutError:
                        if await request.is_disconnected():
                            break
                        yield ": ping\n\n"
                        continue
                    if event is None:
                        break
                    yield event
            finally:
                job.cancel.set()
                if job.task and not job.task.done():
                    job.task.cancel()
                if job.task:
                    with contextlib.suppress(asyncio.CancelledError):
                        await job.task
                job.finished = True

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-store",
                "X-Accel-Buffering": "no",
                "X-Content-Type-Options": "nosniff",
            },
        )

    @app.delete("/api/jobs/{job_id}", status_code=204)
    async def cancel(job_id: str, authorization: str = Header(default="")):
        job = store.jobs.get(job_id)
        if not job or not secrets.compare_digest(authorization, "Bearer " + job.token):
            raise HTTPException(404, "작업을 찾을 수 없습니다.")
        job.cancel.set()
        if job.task and not job.task.done():
            job.task.cancel()

    return app


app = create_app()
