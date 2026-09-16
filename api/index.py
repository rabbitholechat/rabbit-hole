"""Vercel ASGI entrypoint; backend source remains in src/backend."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src' / 'backend'))
from rabbit_hole.app import app  # noqa: E402,F401
