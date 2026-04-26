"""CLI for the OpenPawlet console.

The console is now a single-process FastAPI application: it hosts the
REST surface, the OpenAI-compatible ``/v1/*`` endpoints, the queue
admin routes, the SPA static assets and the embedded nanobot runtime
(agent loop, channels, cron, heartbeat) inside one event loop.  Hence
this CLI exposes only three subcommands:

* ``console start``  - run the unified server (production-style; serves
  the prebuilt SPA from ``src/console/web/dist``).
* ``console init-config``  - write a default ``nanobot_web.json``.
* ``console web ...``  - run the Vite dev server / production build.
"""

from __future__ import annotations

import argparse
import os
import shutil
import socket
import subprocess
import sys
import threading
from pathlib import Path

import uvicorn
from loguru import logger

from console.server.app import create_app
from console.server.config import (
    find_config_file,
    get_settings,
    write_default_config,
)
from console.server.runtime_log_setup import setup_console_runtime_file_logging
from console.server.signals import (
    configure_windows_event_loop_policy,
    install_signal_handlers,
)


def _wait_forever_until_interrupted(reason: str) -> None:
    """Keep process alive for supervisor-managed standby mode."""
    import signal

    logger.warning(reason)
    stop_event = threading.Event()

    previous = install_signal_handlers(stop_event.set)
    try:
        while not stop_event.wait(timeout=1.0):
            pass
    except KeyboardInterrupt:  # pragma: no cover - user abort
        logger.info("Standby interrupted; exiting.")
    finally:
        for sig, handler in previous:
            try:
                signal.signal(sig, handler)
            except (ValueError, OSError):  # pragma: no cover
                pass


def _is_bind_address_in_use(host: str, port: int) -> bool:
    """Return True when target host/port cannot be bound."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((host, port))
        return False
    except OSError:
        return True
    finally:
        sock.close()


def _web_root() -> Path:
    """Return the path to the ``web`` frontend directory."""
    return Path(__file__).resolve().parent / "web"


def _web_dir_or_exit() -> Path:
    """Return the web directory, or exit if ``package.json`` is missing."""
    web_dir = _web_root()
    pkg = web_dir / "package.json"
    if not pkg.is_file():
        raise SystemExit(
            f"Missing package.json at {web_dir}; run npm install in that directory first."
        )
    return web_dir


def _npm_executable() -> str:
    """Locate npm in a Windows-friendly way for subprocess execution."""
    candidates = ["npm.cmd", "npm"] if os.name == "nt" else ["npm"]
    for candidate in candidates:
        found = shutil.which(candidate)
        if found:
            return found
    raise SystemExit(
        "npm executable not found. Install Node.js and ensure npm is on PATH "
        "(Windows usually provides npm.cmd)."
    )


def _run_npm_web(npm_script: str) -> None:
    """Run ``npm run <script>`` in the bundled ``web`` directory."""
    web_dir = _web_dir_or_exit()
    npm_bin = _npm_executable()
    result = subprocess.run(
        [npm_bin, "run", npm_script],
        cwd=str(web_dir),
        check=False,
    )
    sys.exit(result.returncode)


def _run_start(*, mount_spa: bool = True) -> None:
    """Run the unified FastAPI app (REST + SPA + OpenAI + queues + nanobot)."""
    settings = get_settings()
    if _is_bind_address_in_use(settings.host, settings.port):
        _wait_forever_until_interrupted(
            f"[server] {settings.host}:{settings.port} already in use; "
            "assuming another OpenPawlet server is running and entering standby mode."
        )
        return
    setup_console_runtime_file_logging(app_log_level=settings.log_level)
    app = create_app(settings, mount_spa=mount_spa)
    uvicorn.run(
        app,
        host=settings.host,
        port=settings.port,
        reload=False,
        workers=settings.effective_workers,
        log_level=settings.log_level.lower(),
    )


def _run_init_config(force: bool = False) -> None:
    """Write a default ``nanobot_web.json`` next to the nanobot config file."""
    path = find_config_file()
    if path.exists() and not force:
        raise SystemExit(f"Config already exists at {path}. Pass --force to overwrite.")
    written = write_default_config(path)
    print(f"Wrote default server config to {written}")


def main() -> None:
    """Parse CLI arguments and dispatch to subcommands."""
    configure_windows_event_loop_policy()

    parser = argparse.ArgumentParser(
        description=(
            "OpenPawlet console: unified FastAPI server (REST + SPA + OpenAI "
            "API + queues admin + embedded nanobot)."
        ),
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    start_parser = subparsers.add_parser(
        "start",
        help=(
            "Run the unified server. The embedded nanobot runtime "
            "(agent + channels + cron + heartbeat) starts in the same "
            "event loop, so a single HTTP port serves everything."
        ),
    )
    start_parser.add_argument(
        "--no-spa",
        action="store_true",
        help=(
            "Do not mount the prebuilt SPA. Useful in headless setups "
            "where only the API surface is needed."
        ),
    )

    # Backwards-compatible alias used by older docs/scripts.
    subparsers.add_parser(
        "server",
        help="Alias of 'start' kept for backwards compatibility.",
    )

    init_parser = subparsers.add_parser(
        "init-config",
        help="Write a default nanobot_web.json next to the nanobot config.",
    )
    init_parser.add_argument(
        "--force",
        action="store_true",
        help="Overwrite an existing file.",
    )

    web_parser = subparsers.add_parser(
        "web",
        help="Frontend: Vite dev server or production build.",
    )
    web_sub = web_parser.add_subparsers(dest="web_action", required=True)
    web_sub.add_parser(
        "dev",
        help="Development: start Vite with HMR (npm run dev).",
    )
    web_sub.add_parser(
        "build",
        help="Production: typecheck and bundle assets (npm run build).",
    )

    args = parser.parse_args()
    if args.command == "start":
        _run_start(mount_spa=not args.no_spa)
    elif args.command == "server":
        _run_start(mount_spa=False)
    elif args.command == "init-config":
        _run_init_config(force=bool(args.force))
    elif args.command == "web":
        _run_npm_web(args.web_action)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
