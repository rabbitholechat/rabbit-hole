FROM ghcr.io/astral-sh/uv:python3.13-bookworm-slim
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy PYTHONUNBUFFERED=1
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev
COPY rabbit_hole ./rabbit_hole
RUN useradd --create-home --uid 10001 rabbit
USER rabbit
EXPOSE 8018
CMD ["/app/.venv/bin/uvicorn", "rabbit_hole.app:app", "--host", "0.0.0.0", "--port", "8018", "--workers", "1", "--no-access-log"]
