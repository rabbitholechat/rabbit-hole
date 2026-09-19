from starlette.responses import JSONResponse


class BodyLimitMiddleware:
    """Bound request allocation before Pydantic parsing without wrapping SSE responses."""

    def __init__(self, app, max_bytes: int, max_history_bytes: int | None = None, max_attachment_bytes: int | None = None):
        self.app, self.max_bytes = app, max_bytes
        self.max_history_bytes = max_history_bytes or max_bytes
        self.max_attachment_bytes = max_attachment_bytes or max_bytes

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] not in {"POST", "PUT"}:
            return await self.app(scope, receive, send)
        limit = self.max_history_bytes if scope["path"].startswith("/api/sessions/") else self.max_bytes
        if scope["path"] == "/api/attachments":
            limit = self.max_attachment_bytes
        body = bytearray()
        while True:
            event = await receive()
            if event["type"] == "http.disconnect":
                return
            body.extend(event.get("body", b""))
            if len(body) > limit:
                response = JSONResponse({"detail": "요청 크기가 제한을 초과했습니다."}, status_code=413)
                return await response(scope, receive, send)
            if not event.get("more_body", False):
                break
        consumed = False

        async def bounded_receive():
            nonlocal consumed
            if not consumed:
                consumed = True
                return {"type": "http.request", "body": bytes(body), "more_body": False}
            return await receive()

        await self.app(scope, bounded_receive, send)
