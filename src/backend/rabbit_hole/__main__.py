import uvicorn

from .config import get_settings

settings = get_settings()
uvicorn.run('rabbit_hole.app:app', host=settings.backend_host, port=settings.backend_port, reload=True)
