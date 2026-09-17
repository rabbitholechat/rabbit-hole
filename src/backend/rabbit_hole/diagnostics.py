"""Levelled structured metadata only. Never log prompts, text, credentials or reasoning."""

import json
import logging
import sys

from uvicorn.logging import DefaultFormatter

logger = logging.getLogger("rabbit_hole.diagnostics")
logger.setLevel(logging.DEBUG)
logger.propagate = False
if not logger.handlers:
    handler = logging.StreamHandler()
    handler.setFormatter(DefaultFormatter("%(levelprefix)s %(message)s", use_colors=sys.stderr.isatty()))
    logger.addHandler(handler)


def enabled(configured: bool) -> bool:
    return configured or sys.gettrace() is not None


def log(level: int, request_id: str, event: str, **metadata):
    logger.log(level, json.dumps({"request_id": request_id, "event": event, **metadata}, ensure_ascii=False))


def write(active: bool, request_id: str, event: str, **metadata):
    if active:
        log(logging.DEBUG, request_id, event, **metadata)
