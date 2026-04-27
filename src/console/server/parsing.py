"""Shared parsing helpers for stored / user-supplied JSON payloads.

These helpers were previously copy/pasted across routers as ``_parse_<x>``
functions.  Centralizing them keeps the validation behaviour consistent and
makes it obvious that we deliberately drop malformed entries instead of
failing the whole request.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ValidationError


def parse_model_list[ModelT: BaseModel](raw_list: Any, model: type[ModelT]) -> list[ModelT]:
    """Validate a list of dicts against ``model``, dropping malformed entries.

    Non-list inputs and non-dict items yield an empty list / are skipped.
    Items that fail validation are silently skipped so a single bad row never
    prevents the rest of the data from loading.
    """
    if not isinstance(raw_list, list):
        return []
    out: list[ModelT] = []
    for item in raw_list:
        if not isinstance(item, dict):
            continue
        try:
            out.append(model.model_validate(item))
        except ValidationError:
            continue
    return out


__all__ = ["parse_model_list"]
