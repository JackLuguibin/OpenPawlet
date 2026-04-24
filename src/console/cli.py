"""CLI for the OpenPawlet console: backend server, web UI, and init helpers."""

from __future__ import annotations

import argparse
import atexit
import os
import shutil
import subprocess
import sys
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


def _nanobot_executable() -> str:
    """Locate the ``nanobot`` CLI installed alongside ``open-pawlet``.

    Prefer the entry-point script next to the current Python interpreter so
    editable installs (``pip install -e .``) are picked up even when the venv
    is not activated; fall back to ``PATH`` lookup as a safety net.
    """
    exe_name = "nanobot.exe" if os.name == "nt" else "nanobot"
    sibling = Path(sys.executable).parent / exe_name
    if sibling.is_file():
        return str(sibling)
    found = shutil.which("nanobot")
    if found:
        return found
    raise FileNotFoundError(
        "nanobot CLI not found. Reinstall OpenPawlet with 'pip install -e .' "
        "(or 'pip install open-pawlet') to expose the nanobot entry point."
    )


def _ensure_nanobot_onboarded(nanobot_bin: str) -> None:
    """Bootstrap ``~/.nanobot/config.json`` on first launch (mirrors the shell helper)."""
    from nanobot.config import get_config_path

    config_path = get_config_path()
    if config_path.is_file():
        return

    logger.info(
        "First run: no nanobot config at {}; running 'nanobot onboard'…",
        config_path,
    )
    result = subprocess.run([nanobot_bin, "onboard"], check=False)
    if result.returncode != 0:
        raise SystemExit(
            f"'nanobot onboard' exited with code {result.returncode}; "
            "aborting 'open-pawlet start'."
        )


def _spawn_nanobot_gateway() -> subprocess.Popen[bytes]:
    """Spawn ``nanobot gateway`` as a managed subprocess for ``open-pawlet start``."""
    nanobot_bin = _nanobot_executable()
    _ensure_nanobot_onboarded(nanobot_bin)
    logger.info("[gateway] Starting nanobot gateway subprocess: {}", nanobot_bin)
    # The child inherits stdio so its logs stream alongside uvicorn output,
    # and stays in the same process group so Ctrl+C reaches it naturally.
    return subprocess.Popen([nanobot_bin, "gateway"])


def _terminate_subprocess(
    proc: subprocess.Popen[bytes] | None, *, timeout: float = 10.0
) -> None:
    """Stop a managed subprocess, escalating to SIGKILL if it ignores SIGTERM."""
    if proc is None or proc.poll() is not None:
        return
    try:
        proc.terminate()
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        logger.warning(
            "[gateway] nanobot gateway did not exit within {}s; killing", timeout
        )
        proc.kill()
    except Exception:  # noqa: BLE001 - best-effort cleanup at shutdown
        logger.exception("[gateway] Failed to stop nanobot gateway subprocess")


def _run_server() -> None:
    """Run the FastAPI server via uvicorn."""
    settings = get_settings()
    setup_console_runtime_file_logging(app_log_level=settings.log_level)
    app = create_app(settings)
    uvicorn.run(
        app,
        host=settings.host,
        port=settings.port,
        reload=settings.reload,
        workers=settings.effective_workers,
        log_level=settings.log_level.lower(),
    )


def _run_start(*, with_gateway: bool = True, strict_gateway: bool = False) -> None:
    """Run FastAPI with the prebuilt SPA mounted, plus an optional gateway subprocess.

    Args:
        with_gateway: When True (default), spawn ``nanobot gateway`` as a
            managed child process so a single invocation brings up everything
            the console needs.
        strict_gateway: When True, abort the whole command (non-zero exit) if
            the gateway cannot be started. Default is a warning + degraded
            mode so the user can still load the UI and fix the gateway
            separately.
    """
    settings = get_settings()
    setup_console_runtime_file_logging(app_log_level=settings.log_level)
    app = create_app(settings, mount_spa=True)

    gateway_proc: subprocess.Popen[bytes] | None = None
    if with_gateway:
        try:
            gateway_proc = _spawn_nanobot_gateway()
        except FileNotFoundError as exc:
            if strict_gateway:
                raise SystemExit(f"[gateway] {exc}") from exc
            logger.warning(
                "[gateway] {}\n[gateway] Continuing without a managed gateway; "
                "WebSocket features will be unavailable until one is running.",
                exc,
            )
        except SystemExit:
            raise
        except Exception as exc:  # noqa: BLE001 - broad on purpose for degraded mode
            if strict_gateway:
                raise
            logger.exception(
                "[gateway] Could not start nanobot gateway subprocess; continuing "
                "in degraded mode (pass --strict-gateway to fail fast): {}",
                exc,
            )
        else:
            atexit.register(_terminate_subprocess, gateway_proc)

    try:
        uvicorn.run(
            app,
            host=settings.host,
            port=settings.port,
            reload=False,
            workers=settings.effective_workers,
            log_level=settings.log_level.lower(),
        )
    finally:
        _terminate_subprocess(gateway_proc)


def _run_gateway_only() -> None:
    """Bootstrap ``~/.nanobot/config.json`` then exec ``nanobot gateway``.

    Used by the ``Procfile`` so honcho can launch the gateway without
    shelling out to a separate bash helper. The current process is replaced
    by ``nanobot gateway`` so signals and exit codes propagate cleanly.
    """
    nanobot_bin = _nanobot_executable()
    _ensure_nanobot_onboarded(nanobot_bin)
    logger.info("[gateway] Exec into nanobot gateway: {}", nanobot_bin)
    os.execv(nanobot_bin, [nanobot_bin, "gateway"])


def _run_init_config(force: bool = False) -> None:
    """Write a default ``nanobot_web.json`` next to the nanobot config file."""
    path = find_config_file()
    if path.exists() and not force:
        raise SystemExit(
            f"Config already exists at {path}. Pass --force to overwrite."
        )
    written = write_default_config(path)
    print(f"Wrote default server config to {written}")


def main() -> None:
    """Parse CLI arguments and dispatch to subcommands."""
    parser = argparse.ArgumentParser(
        description="OpenPawlet console: API server, web UI, and init helpers.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("server", help="Run the FastAPI backend (uvicorn).")
    start_parser = subparsers.add_parser(
        "start",
        help=(
            "Run API server + mount prebuilt SPA + spawn nanobot gateway "
            "(single command, production-style)."
        ),
    )
    start_parser.add_argument(
        "--no-gateway",
        action="store_true",
        help=(
            "Do not spawn the nanobot gateway subprocess. Use when the "
            "gateway is managed externally (e.g. honcho, systemd)."
        ),
    )
    start_parser.add_argument(
        "--strict-gateway",
        action="store_true",
        help=(
            "Exit non-zero when the gateway subprocess cannot be started. "
            "Default is to log a warning and continue in degraded mode."
        ),
    )

    subparsers.add_parser(
        "gateway",
        help=(
            "Bootstrap ~/.nanobot/config.json if missing, then run "
            "'nanobot gateway'. Handy for Procfile entries."
        ),
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
    if args.command == "server":
        _run_server()
    elif args.command == "start":
        _run_start(
            with_gateway=not args.no_gateway,
            strict_gateway=bool(args.strict_gateway),
        )
    elif args.command == "gateway":
        _run_gateway_only()
    elif args.command == "init-config":
        _run_init_config(force=bool(args.force))
    elif args.command == "web":
        _run_npm_web(args.web_action)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
