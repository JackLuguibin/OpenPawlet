"""Console process: append a loguru file sink for API/runtime messages."""

from __future__ import annotations

from openpawlet.utils.runtime_file_log import install_runtime_file_log


def setup_console_runtime_file_logging(
    *,
    app_log_level: str = "INFO",
) -> None:
    """Create ``~/.openpawlet/logs/console.log`` and mirror loguru output there.

    Uvicorn may reconfigure stdlib logging after startup; access logs may still
    appear only on the process stderr (e.g. honcho). Application loguru calls
    are written to this file.
    """
    install_runtime_file_log("console", level=app_log_level)
