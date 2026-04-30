"""Decode ``data:`` URLs (base64) and persist bytes for agent / API ingestion."""

from __future__ import annotations

import base64
import mimetypes
import re
import uuid
from pathlib import Path

from openpawlet.utils.helpers import safe_filename

# OpenAI-style ``data:<mime>;base64,<payload>`` (payload may include newlines).
DATA_URL_RE = re.compile(r"^data:([^;]+);base64,(.+)$", re.DOTALL)

DEFAULT_DATA_URL_MAX_BYTES = 10 * 1024 * 1024


class FileSizeExceededError(Exception):
    """Raised when a decoded data URL exceeds the configured size limit."""


def save_data_url_to_file(
    data_url: str,
    media_dir: Path,
    *,
    max_bytes: int = DEFAULT_DATA_URL_MAX_BYTES,
) -> str | None:
    """Decode a ``data:...;base64,...`` URL, write under *media_dir*, return absolute path.

    Returns ``None`` if the string is not a matching data URL or base64 decode fails.
    Raises :class:`FileSizeExceededError` when decoded size exceeds *max_bytes*.
    """
    m = DATA_URL_RE.match(data_url)
    if not m:
        return None
    mime_type, b64_payload = m.group(1), m.group(2)
    try:
        raw = base64.b64decode(b64_payload)
    except Exception:
        return None
    if len(raw) > max_bytes:
        raise FileSizeExceededError(f"File exceeds {max_bytes // (1024 * 1024)}MB limit")
    ext = mimetypes.guess_extension(mime_type) or ".bin"
    filename = f"{uuid.uuid4().hex[:12]}{ext}"
    dest = media_dir / safe_filename(filename)
    dest.write_bytes(raw)
    return str(dest)
