"""Session management for conversation history."""

import json
import os
import shutil
from contextlib import suppress
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

from loguru import logger

if TYPE_CHECKING:
    from openpawlet.session.transcript import SessionTranscriptWriter

from openpawlet.config.paths import get_legacy_sessions_dir
from openpawlet.utils.helpers import (
    ensure_dir,
    find_legal_message_start,
    local_now,
    safe_filename,
    timestamp,
)


def _as_agent_aware(dt: datetime, agent_tz: str | None) -> datetime:
    """Attach agent zone to naive datetimes from legacy session files."""
    if dt.tzinfo is not None:
        return dt
    anchor = local_now(agent_tz)
    tz = anchor.tzinfo
    if tz is not None:
        return dt.replace(tzinfo=tz)
    return dt.astimezone()


@dataclass
class Session:
    """A conversation session."""

    key: str  # channel:chat_id
    messages: list[dict[str, Any]] = field(default_factory=list)
    created_at: datetime | None = None
    updated_at: datetime | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
    last_consolidated: int = 0  # Number of messages already consolidated to files
    agent_timezone: str | None = field(default=None, compare=False, repr=False)
    # True when this object reflects state that was read from disk or has been save()d once.
    # Used to drop stale in-process cache when another process removes the session file
    # without discarding in-memory sessions that have never been persisted yet.
    _disk_anchored: bool = field(default=False, compare=False, repr=False)

    def __post_init__(self) -> None:
        n = local_now(self.agent_timezone)
        if self.created_at is None:
            self.created_at = n
        if self.updated_at is None:
            self.updated_at = n

    def add_message(self, role: str, content: str, **kwargs: Any) -> None:
        """Add a message to the session."""
        tz = self.agent_timezone
        msg = {"role": role, "content": content, "timestamp": timestamp(tz), **kwargs}
        self.messages.append(msg)
        self.updated_at = local_now(tz)

    def get_history(self, max_messages: int = 500) -> list[dict[str, Any]]:
        """Return unconsolidated messages for LLM input, aligned to a legal tool-call boundary."""
        unconsolidated = self.messages[self.last_consolidated :]
        sliced = unconsolidated[-max_messages:]

        # Avoid starting mid-turn when possible, except for proactive
        # assistant deliveries (heartbeat/cron/message-tool) that the user
        # may be replying to — keep them as immediate context.
        for i, message in enumerate(sliced):
            if message.get("role") == "user":
                start = i
                if i > 0 and sliced[i - 1].get("_channel_delivery"):
                    start = i - 1
                sliced = sliced[start:]
                break

        # Drop orphan tool results at the front.
        start = find_legal_message_start(sliced)
        if start:
            sliced = sliced[start:]

        out: list[dict[str, Any]] = []
        for message in sliced:
            entry: dict[str, Any] = {"role": message["role"], "content": message.get("content", "")}
            # NOTE: ``reply_group_id`` is intentionally excluded — it is a
            # UI-only marker (UUID for one Agent reply turn) we persist in
            # ``session.messages`` and transcript JSONL, but it must not leak
            # into the LLM request payload (some providers reject unknown
            # message keys; see test_next_turn_after_llm_error_keeps_turn_boundary).
            for key in ("tool_calls", "tool_call_id", "name", "reasoning_content"):
                if key in message:
                    entry[key] = message[key]
            out.append(entry)
        return out

    def clear(self) -> None:
        """Clear all messages and reset session to initial state."""
        self.messages = []
        self.last_consolidated = 0
        self.updated_at = local_now(self.agent_timezone)

    def retain_recent_legal_suffix(
        self,
        max_messages: int,
        *,
        transcript: "SessionTranscriptWriter | None" = None,
    ) -> None:
        """Keep a legal recent suffix, mirroring get_history boundary rules."""
        if max_messages <= 0:
            if transcript and transcript.enabled and self.messages:
                transcript.append_evicted(self.key, "retain_suffix_clear", list(self.messages))
            self.clear()
            return
        if len(self.messages) <= max_messages:
            return

        start_idx = max(0, len(self.messages) - max_messages)

        # If the cutoff lands mid-turn, extend backward to the nearest user turn.
        while start_idx > 0 and self.messages[start_idx].get("role") != "user":
            start_idx -= 1

        retained = self.messages[start_idx:]

        # Mirror get_history(): avoid persisting orphan tool results at the front.
        orphan_drop = find_legal_message_start(retained) or 0
        if orphan_drop:
            retained = retained[orphan_drop:]

        end_evict = start_idx + orphan_drop
        if transcript and transcript.enabled and end_evict > 0:
            transcript.append_evicted(
                self.key,
                "retain_suffix_evict",
                list(self.messages[:end_evict]),
            )

        dropped = len(self.messages) - len(retained)
        self.messages = retained
        self.last_consolidated = max(0, self.last_consolidated - dropped)
        self.updated_at = local_now(self.agent_timezone)


"""Process-wide registry of live SessionManager instances keyed by workspace.

The console HTTP layer constructs a throwaway ``SessionManager`` per request
to read/write JSONL files, but the embedded OpenPawlet runtime keeps its **own**
long-lived ``SessionManager`` whose ``_cache`` holds the agent-loop's view of
each session. Mutations performed by the console (notably session delete)
must invalidate the runtime cache too; otherwise a still-cached in-memory
copy gets re-flushed to disk on shutdown, resurrecting the row the user just
removed. Runtimes register themselves via :func:`_register_runtime_manager`
on start; console code looks them up with :func:`get_runtime_manager`.
"""
_runtime_managers: dict[Path, "SessionManager"] = {}


def _register_runtime_manager(manager: "SessionManager") -> None:
    """Publish *manager* as the live runtime cache for its workspace."""
    _runtime_managers[manager.workspace.resolve()] = manager


def _unregister_runtime_manager(manager: "SessionManager") -> None:
    """Remove *manager* from the registry on runtime shutdown."""
    key = manager.workspace.resolve()
    if _runtime_managers.get(key) is manager:
        _runtime_managers.pop(key, None)


def get_runtime_manager(workspace: Path) -> "SessionManager | None":
    """Return the runtime ``SessionManager`` for *workspace*, if one is live.

    The console process uses this to forward cache-affecting mutations to
    the embedded OpenPawlet runtime without taking a hard import dependency on
    the runtime module (avoids a circular import with ``openpawlet.runtime``).
    """
    return _runtime_managers.get(workspace.resolve())


class SessionManager:
    """
    Manages conversation sessions.

    Sessions are stored as JSONL files in the sessions directory.
    """

    def __init__(self, workspace: Path, timezone: str | None = None):
        self.workspace = workspace
        self._timezone = timezone
        self.sessions_dir = ensure_dir(self.workspace / "sessions")
        self.legacy_sessions_dir = get_legacy_sessions_dir()
        self._cache: dict[str, Session] = {}

    @property
    def agent_timezone(self) -> str | None:
        """IANA timezone for session clocks (same source as :attr:`AgentLoop.timezone`)."""
        return self._timezone

    def configure_timezone(self, tz: str | None) -> None:
        """Set the agent timezone used for new timestamps and naive-datetime repair."""
        self._timezone = tz

    @staticmethod
    def safe_key(key: str) -> str:
        """Map a session key to a stable filename stem (shared with HTTP helpers)."""
        return safe_filename(key.replace(":", "_"))

    def _get_session_path(self, key: str) -> Path:
        """Get the file path for a session."""
        return self.sessions_dir / f"{self.safe_key(key)}.jsonl"

    def _get_legacy_session_path(self, key: str) -> Path:
        """Legacy global session path (~/.openpawlet/sessions/)."""
        return self.legacy_sessions_dir / f"{self.safe_key(key)}.jsonl"

    def get_or_create(self, key: str) -> Session:
        """
        Get an existing session or create a new one.

        Args:
            key: Session key (usually channel:chat_id).

        Returns:
            The session.
        """
        primary = self._get_session_path(key)
        legacy = self._get_legacy_session_path(key)
        if key in self._cache:
            if primary.is_file():
                sess = self._cache[key]
                sess.agent_timezone = self._timezone
                return sess
            if legacy.is_file():
                # Legacy migration in _load() needs a clean cache.
                self.invalidate(key)
            elif self._cache[key]._disk_anchored:
                # File removed externally (e.g. console API); drop stale in-memory state.
                self.invalidate(key)
            else:
                # In-memory only: not yet on disk, keep the cached session.
                sess = self._cache[key]
                sess.agent_timezone = self._timezone
                return sess

        session = self._load(key)
        if session is None:
            session = Session(key=key, agent_timezone=self._timezone)
        else:
            session.agent_timezone = self._timezone

        self._cache[key] = session
        return session

    def _load(self, key: str) -> Session | None:
        """Load a session from disk."""
        path = self._get_session_path(key)
        if not path.exists():
            legacy_path = self._get_legacy_session_path(key)
            if legacy_path.exists():
                try:
                    shutil.move(str(legacy_path), str(path))
                    logger.info("Migrated session {} from legacy path", key)
                except Exception:
                    logger.exception("Failed to migrate session {}", key)

        if not path.exists():
            return None

        try:
            messages = []
            metadata = {}
            created_at = None
            updated_at = None
            last_consolidated = 0

            with open(path, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue

                    data = json.loads(line)

                    if data.get("_type") == "metadata":
                        metadata = data.get("metadata", {})
                        created_at = (
                            _as_agent_aware(
                                datetime.fromisoformat(data["created_at"].replace("Z", "+00:00")),
                                self._timezone,
                            )
                            if data.get("created_at")
                            else None
                        )
                        updated_at = (
                            _as_agent_aware(
                                datetime.fromisoformat(data["updated_at"].replace("Z", "+00:00")),
                                self._timezone,
                            )
                            if data.get("updated_at")
                            else None
                        )
                        last_consolidated = data.get("last_consolidated", 0)
                    else:
                        messages.append(data)

            return Session(
                key=key,
                messages=messages,
                created_at=created_at or local_now(self._timezone),
                updated_at=updated_at or local_now(self._timezone),
                metadata=metadata,
                last_consolidated=last_consolidated,
                agent_timezone=self._timezone,
                _disk_anchored=True,
            )
        except Exception as e:
            logger.warning("Failed to load session {}: {}", key, e)
            repaired = self._repair(key)
            if repaired is not None:
                logger.info(
                    "Recovered session {} from corrupt file ({} messages)",
                    key,
                    len(repaired.messages),
                )
                repaired._disk_anchored = True
            return repaired

    def _repair(self, key: str) -> Session | None:
        """Attempt to recover a session from a corrupt JSONL file."""
        path = self._get_session_path(key)
        if not path.exists():
            return None

        try:
            messages: list[dict[str, Any]] = []
            metadata: dict[str, Any] = {}
            created_at: datetime | None = None
            updated_at: datetime | None = None
            last_consolidated = 0
            skipped = 0

            with open(path, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        data = json.loads(line)
                    except json.JSONDecodeError:
                        skipped += 1
                        continue

                    if data.get("_type") == "metadata":
                        metadata = data.get("metadata", {})
                        if data.get("created_at"):
                            with suppress(ValueError, TypeError):
                                created_at = _as_agent_aware(
                                    datetime.fromisoformat(
                                        data["created_at"].replace("Z", "+00:00")
                                    ),
                                    self._timezone,
                                )
                        if data.get("updated_at"):
                            with suppress(ValueError, TypeError):
                                updated_at = _as_agent_aware(
                                    datetime.fromisoformat(
                                        data["updated_at"].replace("Z", "+00:00")
                                    ),
                                    self._timezone,
                                )
                        last_consolidated = data.get("last_consolidated", 0)
                    else:
                        messages.append(data)

            if skipped:
                logger.warning("Skipped {} corrupt lines in session {}", skipped, key)

            if not messages and not metadata:
                return None

            return Session(
                key=key,
                messages=messages,
                created_at=created_at or local_now(self._timezone),
                updated_at=updated_at or local_now(self._timezone),
                metadata=metadata,
                last_consolidated=last_consolidated,
                agent_timezone=self._timezone,
                _disk_anchored=True,
            )
        except Exception as e:
            logger.warning("Repair failed for session {}: {}", key, e)
            return None

    @staticmethod
    def _session_payload(session: Session) -> dict[str, Any]:
        return {
            "key": session.key,
            "created_at": session.created_at.isoformat(),
            "updated_at": session.updated_at.isoformat(),
            "metadata": session.metadata,
            "messages": session.messages,
        }

    def save(self, session: Session, *, fsync: bool = False) -> None:
        """Save a session to disk atomically.

        When *fsync* is ``True`` the final file and its parent directory are
        explicitly flushed to durable storage.  This is intentionally off by
        default (the OS page-cache is sufficient for normal operation) but
        should be enabled during graceful shutdown so that filesystems with
        write-back caching (e.g. rclone VFS, NFS, FUSE mounts) do not lose
        the most recent writes.
        """
        path = self._get_session_path(session.key)
        tmp_path = path.with_suffix(".jsonl.tmp")
        legacy_path = self._get_legacy_session_path(session.key)

        # If a previously persisted session was externally deleted (console
        # DELETE /sessions, another process, etc.), do not resurrect it from
        # the still-cached in-memory copy. Drop the cache entry and skip the
        # write entirely, so the deletion is honored on shutdown flush as
        # well as during regular per-turn saves.
        if session._disk_anchored and (not path.is_file()) and (not legacy_path.is_file()):
            self._cache.pop(session.key, None)
            return

        try:
            with open(tmp_path, "w", encoding="utf-8") as f:
                metadata_line = {
                    "_type": "metadata",
                    "key": session.key,
                    "created_at": session.created_at.isoformat(),
                    "updated_at": session.updated_at.isoformat(),
                    "metadata": session.metadata,
                    "last_consolidated": session.last_consolidated,
                }
                f.write(json.dumps(metadata_line, ensure_ascii=False) + "\n")
                for msg in session.messages:
                    f.write(json.dumps(msg, ensure_ascii=False) + "\n")
                if fsync:
                    f.flush()
                    os.fsync(f.fileno())

            os.replace(tmp_path, path)
            session._disk_anchored = True

            if fsync:
                # fsync the directory so the rename is durable.
                # On Windows, opening a directory with O_RDONLY raises
                # PermissionError — skip the dir sync there (NTFS
                # journals metadata synchronously).
                with suppress(PermissionError):
                    fd = os.open(str(path.parent), os.O_RDONLY)
                    try:
                        os.fsync(fd)
                    finally:
                        os.close(fd)
        except BaseException:
            tmp_path.unlink(missing_ok=True)
            raise

        self._cache[session.key] = session

    def flush_all(self) -> int:
        """Re-save every cached session with fsync for durable shutdown.

        Sessions that carry no messages **and** no metadata are skipped:
        these typically come from short-lived interactions (a new
        WebSocket client opening a chat and only running ``/status``,
        the heartbeat probe, or a console session that the user just
        deleted) where flushing them would resurrect a ghost row in the
        sidebar on every restart.  When such a session is also missing
        on disk we drop it from the in-memory cache too, so subsequent
        ``get_or_create`` reloads start clean.

        Returns the number of sessions flushed.  Errors on individual
        sessions are logged but do not prevent other sessions from being
        flushed.
        """
        flushed = 0
        for key, session in list(self._cache.items()):
            path = self._get_session_path(key)
            file_exists = path.is_file()
            # Fully empty + never persisted → drop without writing. Catches
            # short-lived caches such as a `/status` poll on a brand-new WS
            # client that the user never actually chatted in.
            if not session.messages and not session.metadata:
                if not file_exists:
                    self._cache.pop(key, None)
                continue
            # Disk-anchored but the file is gone (console DELETE / external
            # rm). ``save`` will honour this by dropping the cache entry,
            # but we must skip the flush counter and ``save`` invocation
            # cleanly so we don't surface a write that was actually a noop.
            if session._disk_anchored and not file_exists:
                self._cache.pop(key, None)
                continue
            try:
                self.save(session, fsync=True)
                flushed += 1
            except Exception:
                logger.warning("Failed to flush session {}", key, exc_info=True)
        return flushed

    def invalidate(self, key: str) -> None:
        """Remove a session from the in-memory cache."""
        self._cache.pop(key, None)

    def delete_session(self, key: str) -> bool:
        """Remove a session from disk and the in-memory cache.

        Returns True if a JSONL file was found and unlinked.
        """
        path = self._get_session_path(key)
        self.invalidate(key)
        if not path.exists():
            return False
        try:
            path.unlink()
            return True
        except OSError as e:
            logger.warning("Failed to delete session file {}: {}", path, e)
            return False

    def read_session_file(self, key: str) -> dict[str, Any] | None:
        """Load a session from disk without caching; intended for read-only HTTP endpoints.

        Returns ``{"key", "created_at", "updated_at", "metadata", "messages"}`` or
        ``None`` when the session file does not exist or fails to parse.
        """
        path = self._get_session_path(key)
        if not path.exists():
            return None
        try:
            messages: list[dict[str, Any]] = []
            metadata: dict[str, Any] = {}
            created_at: str | None = None
            updated_at: str | None = None
            stored_key: str | None = None
            with open(path, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    data = json.loads(line)
                    if data.get("_type") == "metadata":
                        metadata = data.get("metadata", {})
                        created_at = data.get("created_at")
                        updated_at = data.get("updated_at")
                        stored_key = data.get("key")
                    else:
                        messages.append(data)
            return {
                "key": stored_key or key,
                "created_at": created_at,
                "updated_at": updated_at,
                "metadata": metadata,
                "messages": messages,
            }
        except Exception as e:
            logger.warning("Failed to read session {}: {}", key, e)
            repaired = self._repair(key)
            if repaired is not None:
                logger.info("Recovered read-only session view {} from corrupt file", key)
                return self._session_payload(repaired)
            return None

    def list_sessions(self) -> list[dict[str, Any]]:
        """
        List all sessions.

        Returns:
            List of session info dicts.
        """
        sessions = []

        for path in self.sessions_dir.glob("*.jsonl"):
            fallback_key = path.stem.replace("_", ":", 1)
            try:
                # Read just the metadata line
                with open(path, encoding="utf-8") as f:
                    first_line = f.readline().strip()
                    if first_line:
                        data = json.loads(first_line)
                        if data.get("_type") == "metadata":
                            key = data.get("key") or path.stem.replace("_", ":", 1)
                            sessions.append(
                                {
                                    "key": key,
                                    "created_at": data.get("created_at"),
                                    "updated_at": data.get("updated_at"),
                                    "path": str(path),
                                }
                            )
            except Exception:
                repaired = self._repair(fallback_key)
                if repaired is not None:
                    sessions.append(
                        {
                            "key": repaired.key,
                            "created_at": repaired.created_at.isoformat(),
                            "updated_at": repaired.updated_at.isoformat(),
                            "path": str(path),
                        }
                    )
                continue

        return sorted(sessions, key=lambda x: x.get("updated_at", ""), reverse=True)
