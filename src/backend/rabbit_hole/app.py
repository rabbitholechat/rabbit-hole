import asyncio
import contextlib
import json
import logging
import os
import secrets
import time
from collections import defaultdict, deque
from dataclasses import dataclass, field

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import StreamingResponse

from . import diagnostics
from .agent import AgentService
from .config import Settings, get_settings
from .errors import MESSAGES, StageFailure, error_code, error_location
from .middleware import BodyLimitMiddleware
from .models import AgentRequest, ConversationTurn, Snapshot, TitleRequest, TitleResponse
from .security import SnapshotSigner


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
            raise HTTPException(429, "잠시 후 다시 요청하세요.", headers={"Retry-After": "60"})
        if sum(not j.finished for j in self.jobs.values()) >= self.settings.max_concurrent_jobs:
            raise HTTPException(429, "요청이 많습니다. 잠시 후 다시 시도하세요.")
        timestamps.append(now)
        if len(self.jobs) >= self.settings.max_stored_jobs:
            finished = [j for j in self.jobs.values() if j.finished]
            if finished:
                del self.jobs[min(finished, key=lambda j: j.created).id]
            else:
                raise HTTPException(429, "요청 저장소가 가득 찼습니다.")
        job = Job()
        self.jobs[job.id] = job
        return job


def trim_context(turns: list[ConversationTurn], settings: Settings) -> list[ConversationTurn]:
    """Keep complete recent exchanges, never a dangling assistant message."""
    turns = list(turns)
    while len(turns) > settings.max_context_turns or sum(len(t.content) for t in turns) > 96000:
        turns = turns[2:]
    return turns


def create_app(settings: Settings | None = None, service_factory=AgentService) -> FastAPI:
    settings = settings or get_settings()
    if os.environ.get("VERCEL") and len(settings.session_signing_key.get_secret_value()) < 32:
        raise RuntimeError("SESSION_SIGNING_KEY must contain at least 32 characters on Vercel")
    app = FastAPI(title="Rabbit Hole", version="0.2.0")
    app.add_middleware(BodyLimitMiddleware, max_bytes=settings.max_request_bytes)
    store = JobStore(settings)
    signer = SnapshotSigner(settings.session_signing_key.get_secret_value())
    app.state.store = store

    @app.get("/api/health")
    async def health():
        return {"status": "ok", "configured": settings.configured, "api_version": 2}

    @app.post(
        "/api/agent",
        response_class=StreamingResponse,
        responses={
            200: {
                "description": "Agent text SSE v2; see docs/API.md",
                "content": {"text/event-stream": {"schema": {"type": "string"}}},
            },
            409: {"description": "Invalid, expired or incompatible continuation"},
            413: {"description": "Request body exceeds configured byte limit"},
            429: {"description": "Rate or concurrent job limit"},
            503: {"description": "Model configuration is missing"},
        },
    )
    async def respond(body: AgentRequest, request: Request):
        conversation = []
        if body.continuation:
            try:
                conversation = signer.verify(body.continuation).conversation
            except ValueError as error:
                raise HTTPException(409, str(error)) from error
        if not settings.configured:
            raise HTTPException(503, "모델 API가 설정되지 않았습니다. 백엔드 .env의 키를 설정하세요.")
        job = store.create(request.client.host if request.client else "unknown")
        queue: asyncio.Queue = asyncio.Queue()
        seq = 0
        request_id = str(body.request_id)
        response_id = f"response_{request_id}"
        debug = diagnostics.enabled(settings.debug_diagnostics)

        async def emit(kind: str, data: dict):
            nonlocal seq
            if job.cancel.is_set():
                raise asyncio.CancelledError()
            seq += 1
            envelope = {
                "version": 2,
                "request_id": request_id,
                "job_id": job.id,
                "seq": seq,
                "type": kind,
                "data": data,
            }
            await queue.put(f"id: {seq}\nevent: {kind}\ndata: {json.dumps(envelope, ensure_ascii=False)}\n\n")

        async def checkpoint():
            state = Snapshot(conversation=conversation, issued_at=time.time())
            await emit("checkpoint", {"continuation": signer.sign(state)})

        async def produce():
            nonlocal conversation
            service = None
            text = ""
            status = "failed"
            failed = []
            diagnostics.log(logging.INFO, request_id, "request_started", job_id=job.id)
            try:
                await emit("started", {"access_token": job.token, "status": "running"})
                # Safe retry context is available even if the response is cancelled midway.
                await checkpoint()
                await emit("response_started", {"id": response_id})
                await emit("status", {"stage": "responding"})
                inputs = conversation + [ConversationTurn(role="user", content=body.query)]
                diagnostics.write(
                    debug,
                    request_id,
                    "agent_start",
                    model=settings.openai_model,
                    context_turns=len(inputs),
                    context_chars=sum(len(t.content) for t in inputs),
                    tools=0,
                    max_turns=settings.max_model_turns,
                )
                async with asyncio.timeout(settings.job_timeout_seconds):
                    service = service_factory(settings)
                    async with contextlib.aclosing(service.stream(inputs)) as deltas:
                        async for delta in deltas:
                            if not delta:
                                continue
                            if len(text) + len(delta) > 64000:
                                raise StageFailure("response", "output_limit")
                            text += delta
                            await emit("response_delta", {"id": response_id, "delta": delta})
                            diagnostics.write(
                                debug,
                                request_id,
                                "response_delta",
                                seq=seq,
                                delta_chars=len(delta),
                                total_chars=len(text),
                            )
                if not text.strip():
                    raise StageFailure("response", "invalid_output")
                conversation = trim_context(
                    inputs + [ConversationTurn(role="assistant", content=text)], settings
                )
                await emit("response_completed", {"id": response_id, "text": text})
                status = "completed"
            except asyncio.CancelledError:
                job.cancel.set()
                status = "cancelled"
                raise
            except Exception as error:
                status = "partial" if text else "failed"
                code = error_code(error)
                failed = ["response"]
                diagnostics.log(
                    logging.ERROR,
                    request_id,
                    "request_failed",
                    part="response",
                    code=code,
                    exception=type(error).__name__,
                    location=error_location(error),
                )
                await emit("part_error", {"part": "response", "code": code, "message": MESSAGES[code]})
            finally:
                try:
                    if not job.cancel.is_set():
                        await checkpoint()
                        await emit("done", {"status": status, "failed_parts": failed})
                finally:
                    if service:
                        try:
                            await service.close()
                        except Exception as error:
                            diagnostics.log(
                                logging.WARNING, request_id, "cleanup_failed", exception=type(error).__name__
                            )
                    diagnostics.log(
                        logging.INFO,
                        request_id,
                        "request_finished",
                        status=status,
                        output_chars=len(text),
                        elapsed_ms=round((time.monotonic() - job.created) * 1000),
                    )
                    job.finished = True
                    await queue.put(None)

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

    @app.post("/api/title", response_model=TitleResponse)
    async def title(body: TitleRequest, request: Request):
        try:
            conversation = signer.verify(body.continuation).conversation
        except ValueError as error:
            raise HTTPException(409, str(error)) from error
        if [turn.role for turn in conversation] != ["user", "assistant"]:
            raise HTTPException(409, "첫 응답이 완료된 대화만 제목을 생성할 수 있습니다.")
        if not settings.configured:
            raise HTTPException(503, "모델 API가 설정되지 않았습니다.")
        job = store.create(request.client.host if request.client else "unknown")
        request_id = str(body.request_id)
        service = None
        diagnostics.log(logging.INFO, request_id, "title_started")
        diagnostics.write(
            diagnostics.enabled(settings.debug_diagnostics), request_id, "title_model",
            model=settings.openai_background_model,
        )
        try:
            async with asyncio.timeout(settings.background_timeout_seconds):
                service = service_factory(settings)
                result = TitleResponse(title=await service.title(conversation))
            diagnostics.log(logging.INFO, request_id, "title_completed",
                            elapsed_ms=round((time.monotonic() - job.created) * 1000))
            return result
        except Exception as error:
            diagnostics.log(logging.WARNING, request_id, "title_failed",
                            code=error_code(error), exception=type(error).__name__)
            raise HTTPException(502, "대화 제목을 생성하지 못했습니다.") from error
        finally:
            job.finished = True
            if service:
                try:
                    await service.close()
                except Exception as error:
                    diagnostics.log(logging.WARNING, request_id, "cleanup_failed",
                                    exception=type(error).__name__)

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
