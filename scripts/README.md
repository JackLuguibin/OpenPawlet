# Scripts

Maintenance scripts for this repository. They are **not** shipped in the `open-pawlet` wheel.

## `bump_open_pawlet_version.py`

Bumps the **open-pawlet** release version consistently across the repo. Semantics follow **SemVer 2.0.0**; version strings are **PEP 440** (PyPI-compatible). The bundled **OpenPawlet** framework version is **not** managed as a separate target by this script (it still follows existing `pyproject.toml` / package metadata logic). **Bridge** (`bridge/package.json`, `bridge/src/whatsapp.ts`) versions are **not** updated here; keep them on their own release cadence if needed.

### Requirements

Install the **`dev`** optional dependency group (includes `packaging`), from the repo root:

```bash
pip install -e ".[dev]"
# or: uv sync --extra dev
```

### Files updated

The canonical version is `[project] version` in `pyproject.toml`. The script writes the new version to:

| File | Field |
|------|--------|
| `pyproject.toml` | `[project] version` |
| `src/console/server/config/schema.py` | skipped — API version from `openpawlet_distribution_version()` after reinstall |
| `src/console/web/package.json` | `"version"` |
| `src/console/web/package-lock.json` | Root and `packages[""]` `version` |

### Usage

From the repo root:

```bash
python scripts/bump_open_pawlet_version.py
```

With no bump flags, an **interactive** menu runs (major / minor / patch / prerelease / stable release).

**Non-interactive** (CI or automation) examples:

```bash
# Preview only; no writes
python scripts/bump_open_pawlet_version.py --patch --dry-run

# Bump patch and write without confirmation
python scripts/bump_open_pawlet_version.py --patch --yes

# Write, then git add the touched files (no commit)
python scripts/bump_open_pawlet_version.py --minor --yes --git-add
```

### CLI flags

| Flag | Description |
|------|-------------|
| `--major` / `--minor` / `--patch` | Increment the segment; result is a stable `X.Y.Z` (mutually exclusive) |
| `--prerelease KIND` | `alpha`, `beta`, or `rc` — bump or create a PEP 440 prerelease |
| `--release` | Drop prerelease/dev/post/local; keep `X.Y.Z` |
| `--yes` / `-y` | Skip confirmation before writing |
| `--dry-run` | Print old/new version and file list; do not write |
| `--git-add` | After writing, `git add` the updated files |

Before publishing, run `python -m build` and `twine check dist/*` locally; this matches the usual release checks.
