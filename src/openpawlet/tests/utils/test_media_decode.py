"""Tests for :mod:`openpawlet.utils.media_decode`."""

from __future__ import annotations

import base64
from pathlib import Path

import pytest

from openpawlet.utils.media_decode import (
    DATA_URL_RE,
    FileSizeExceededError,
    save_data_url_to_file,
)


def test_data_url_re_matches_standard_form() -> None:
    s = "data:image/png;base64,SGVsbG8="
    assert DATA_URL_RE.match(s)


def test_save_data_url_saves_png(tmp_path: Path) -> None:
    b64_data = base64.b64encode(b"fake png data").decode()
    data_url = f"data:image/png;base64,{b64_data}"
    result = save_data_url_to_file(data_url, tmp_path)
    assert result is not None
    assert result.endswith(".png")
    rel = result.replace(str(tmp_path) + "/", "")
    assert (tmp_path / rel).read_bytes() == b"fake png data"


def test_save_data_url_invalid_b64_returns_none(tmp_path: Path) -> None:
    assert (
        save_data_url_to_file("data:image/png;base64,not-valid-base64!!!", tmp_path) is None
    )


def test_save_data_url_unknown_mime_uses_bin(tmp_path: Path) -> None:
    b64_data = base64.b64encode(b"some data").decode()
    data_url = f"data:unknown/type;base64,{b64_data}"
    result = save_data_url_to_file(data_url, tmp_path)
    assert result is not None
    assert result.endswith(".bin")


def test_save_data_url_rejects_oversized_payload(tmp_path: Path) -> None:
    large_payload = base64.b64encode(b"x" * (11 * 1024 * 1024)).decode()
    data_url = f"data:image/png;base64,{large_payload}"
    with pytest.raises(FileSizeExceededError, match="10MB limit"):
        save_data_url_to_file(data_url, tmp_path)


def test_save_non_data_url_returns_none(tmp_path: Path) -> None:
    assert save_data_url_to_file("https://example.com/x.png", tmp_path) is None
