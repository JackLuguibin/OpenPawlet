"""CLI for the OpenPawlet console.

The console is now a single-process FastAPI application: it hosts the
REST surface, the OpenAI-compatible ``/v1/*`` endpoints, the queue
admin routes, the SPA static assets and the embedded OpenPawlet runtime
(agent loop, channels, cron, heartbeat) inside one event loop.  Hence
this CLI implementation lives alongside the FastAPI app; end users invoke the
same subcommands via the unified ``open-pawlet`` Typer entrypoint
(see :mod:`openpawlet.cli.commands`).

* ``open-pawlet start`` / ``server`` — run the unified server (production-style;
  serves the prebuilt SPA from ``src/console/web/dist``).
* ``open-pawlet init-config`` — write a default ``openpawlet_web.json``.
* ``open-pawlet web ...`` — run the Vite dev server / production build.
"""

from __future__ import annotations

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
from console.server.signals import install_signal_handlers


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


def _npm_invoke_cmd(npm_bin: str, *npm_args: str) -> list[str]:
    """Build argv for npm (or node + npm-cli.js on Windows to avoid batch quirks)."""
    cmd: list[str] = [npm_bin, *npm_args]
    if os.name == "nt" and npm_bin.lower().endswith(".cmd"):
        # Bypass npm.cmd batch wrapper to avoid "Terminate batch job (Y/N)?"
        # and let Ctrl+C interrupt the Node process directly.
        npm_cli = Path(npm_bin).parent / "node_modules" / "npm" / "bin" / "npm-cli.js"
        node_bin = shutil.which("node.exe") or shutil.which("node")
        if npm_cli.is_file() and node_bin:
            cmd = [node_bin, str(npm_cli), *npm_args]
    return cmd


def _web_node_modules_ready(web_dir: Path) -> bool:
    """True when frontend dependencies appear installed (node_modules with .bin)."""
    return (web_dir / "node_modules" / ".bin").is_dir()


def _ensure_web_dependencies(web_dir: Path, npm_bin: str) -> None:
    """Run ``npm install`` in ``web_dir`` when node_modules is missing or incomplete."""
    if _web_node_modules_ready(web_dir):
        return
    logger.info(
        "[web] node_modules not found or incomplete; running npm install in {} ...",
        web_dir,
    )
    install_cmd = _npm_invoke_cmd(npm_bin, "install")
    try:
        completed = subprocess.run(
            install_cmd,
            cwd=str(web_dir),
            check=False,
        )
    except OSError as exc:  # pragma: no cover - exec failure
        raise SystemExit(f"[web] npm install failed to start: {exc}") from exc
    if completed.returncode != 0:
        raise SystemExit(
            f"[web] npm install exited with {completed.returncode}; "
            f"fix the error above or run manually: npm install (cwd {web_dir})"
        )


def _run_npm_web(npm_script: str) -> None:
    """Run ``npm run <script>`` in the bundled ``web`` directory."""
    web_dir = _web_dir_or_exit()
    npm_bin = _npm_executable()
    _ensure_web_dependencies(web_dir, npm_bin)
    cmd = _npm_invoke_cmd(npm_bin, "run", npm_script)

    process = subprocess.Popen(
        cmd,
        cwd=str(web_dir),
    )
    try:
        return_code = process.wait()
    except KeyboardInterrupt:
        logger.info("[web] Interrupt received, shutting down frontend process...")
        process.terminate()
        try:
            return_code = process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            return_code = process.wait()
        sys.exit(return_code if return_code is not None else 130)

    sys.exit(return_code)


_INSECURE_HOSTS = frozenset({"0.0.0.0", "::", "::0"})


def _warn_if_publicly_bound(host: str, port: int) -> None:
    """Loudly warn when the unauthenticated API is bound to a public address.

    The console currently has no auth layer; binding to a non-loopback host
    means any peer that can reach the port has full read/write access to the
    workspace, config and LLM provider keys.
    """
    if host in _INSECURE_HOSTS:
        logger.warning(
            "[server] Binding to {}:{} exposes the UNAUTHENTICATED API to "
            "every reachable network interface. Restrict via firewall or "
            "switch host to 127.0.0.1 unless you fully trust the network.",
            host,
            port,
        )


def _run_start(*, mount_spa: bool = True) -> None:
    """Run the unified FastAPI app (REST + SPA + OpenAI + queues + OpenPawlet)."""
    settings = get_settings()
    if _is_bind_address_in_use(settings.host, settings.port):
        _wait_forever_until_interrupted(
            f"[server] {settings.host}:{settings.port} already in use; "
            "assuming another OpenPawlet server is running and entering standby mode."
        )
        return
    _warn_if_publicly_bound(settings.host, settings.port)
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
    """Write a default ``openpawlet_web.json`` next to the agent ``config.json``."""
    path = find_config_file()
    if path.exists() and not force:
        raise SystemExit(f"Config already exists at {path}. Pass --force to overwrite.")
    written = write_default_config(path)
    print(f"Wrote default server config to {written}")


def main() -> None:
    """Dispatch to the unified ``open-pawlet`` Typer CLI (``python -m console``)."""
    from openpawlet.cli.commands import app

    app()


if __name__ == "__main__":
    main()
