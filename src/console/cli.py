"""CLI for the OpenPawlet console: backend server and web UI (dev / build)."""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

import uvicorn

from console.server.app import create_app
from console.server.config import get_settings
from console.web_dev_wait import wait_for_dev_stack


def _web_root() -> Path:
    """Return the path to the ``web`` frontend directory."""
    return Path(__file__).resolve().parent / "web"


def _web_dir_or_exit() -> Path:
    """Return the web directory, or exit if ``package.json`` is missing."""
    web_dir = _web_root()
    pkg = web_dir / "package.json"
    if not pkg.is_file():
        raise SystemExit(
            f"Missing package.json at {web_dir}; "
            "run npm install in that directory first."
        )
    return web_dir


def _run_npm_web(npm_script: str) -> None:
    """Run ``npm run <script>`` in the bundled ``web`` directory."""
    web_dir = _web_dir_or_exit()
    result = subprocess.run(
        ["npm", "run", npm_script],
        cwd=str(web_dir),
        check=False,
    )
    sys.exit(result.returncode)


def _run_server() -> None:
    """Run the FastAPI server via uvicorn."""
    settings = get_settings()
    app = create_app(settings)
    uvicorn.run(
        app,
        host=settings.host,
        port=settings.port,
        reload=settings.reload,
        workers=settings.effective_workers,
        log_level=settings.log_level.lower(),
    )


def main() -> None:
    """Parse CLI arguments and dispatch to subcommands."""
    parser = argparse.ArgumentParser(
        description="OpenPawlet console: API server and web UI.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("server", help="Run the FastAPI backend (uvicorn).")

    web_parser = subparsers.add_parser(
        "web",
        help="Frontend: Vite dev server or production build.",
    )
    web_sub = web_parser.add_subparsers(dest="web_action", required=True)
    dev_parser = web_sub.add_parser(
        "dev",
        help="Development: start Vite with HMR (npm run dev).",
    )
    dev_parser.add_argument(
        "--no-wait",
        action="store_true",
        help=(
            "Do not wait for the console API / nanobot WebSocket before Vite "
            "(same as SKIP_GATEWAY_WAIT=1)."
        ),
    )
    web_sub.add_parser(
        "build",
        help="Production: typecheck and bundle assets (npm run build).",
    )

    args = parser.parse_args()
    if args.command == "server":
        _run_server()
    elif args.command == "web":
        if (
            args.web_action == "dev"
            and not getattr(args, "no_wait", False)
            and not os.environ.get("SKIP_GATEWAY_WAIT")
        ):
            wait_for_dev_stack()
        _run_npm_web(args.web_action)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
