"""Opt-in source/evidence diagnostics; never log full provider responses or reasoning."""

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


def write(active: bool, request_id: str, event: str, **data):
    if active:
        payload = json.dumps({"request_id": request_id, "event": event, **data}, ensure_ascii=False)
        if event in {"evidence_rejected", "validation_rejected"}:
            logger.error(payload)
        elif event == "source_rejected":
            logger.warning(payload)
        else:
            logger.debug(payload)
