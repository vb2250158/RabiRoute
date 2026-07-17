from __future__ import annotations

import uvicorn

from .app import create_app
from .config import load_settings


def main() -> None:
    settings = load_settings()
    uvicorn.run(create_app(settings), host=settings.server.host, port=settings.server.port, log_level="info")


if __name__ == "__main__":
    main()
