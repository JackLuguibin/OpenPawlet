"""High-level programmatic interface to nanobot."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from nanobot.agent.hook import AgentHook
from nanobot.agent.loop import AgentLoop
from nanobot.bus.queue import MessageBus

if TYPE_CHECKING:
    from nanobot.config.schema import Config

__all__ = ["Nanobot", "RunResult"]


@dataclass(slots=True)
class RunResult:
    """Result of a single agent run."""

    content: str
    tools_used: list[str]
    messages: list[dict[str, Any]]


def _resolve_config(
    config_path: str | Path | None,
    workspace: str | Path | None,
) -> Config:
    """Load + env-resolve a nanobot ``Config`` from disk."""
    from nanobot.config.loader import load_config, resolve_config_env_vars

    resolved: Path | None = None
    if config_path is not None:
        resolved = Path(config_path).expanduser().resolve()
        if not resolved.exists():
            raise FileNotFoundError(f"Config not found: {resolved}")

    config = resolve_config_env_vars(load_config(resolved))
    if workspace is not None:
        config.agents.defaults.workspace = str(Path(workspace).expanduser().resolve())
    return config


def _build_agent_loop(config: Config, *, bus: MessageBus | None = None) -> AgentLoop:
    """Construct an :class:`AgentLoop` from a fully-resolved ``Config``."""
    from nanobot.providers.factory import build_default_provider

    provider = build_default_provider(config)
    defaults = config.agents.defaults
    return AgentLoop(
        bus=bus or MessageBus(),
        provider=provider,
        workspace=config.workspace_path,
        model=defaults.model,
        max_iterations=defaults.max_tool_iterations,
        context_window_tokens=defaults.context_window_tokens,
        context_block_limit=defaults.context_block_limit,
        max_tool_result_chars=defaults.max_tool_result_chars,
        provider_retry_mode=defaults.provider_retry_mode,
        web_config=config.tools.web,
        exec_config=config.tools.exec,
        restrict_to_workspace=config.tools.restrict_to_workspace,
        mcp_servers=config.tools.mcp_servers,
        channels_config=config.channels,
        timezone=defaults.timezone,
        unified_session=defaults.unified_session,
        disabled_skills=defaults.disabled_skills,
        session_ttl_minutes=defaults.session_ttl_minutes,
        tools_config=config.tools,
        persist_session_transcript=defaults.persist_session_transcript,
        transcript_include_full_tool_results=defaults.transcript_include_full_tool_results,
    )


class Nanobot:
    """Programmatic facade for running the nanobot agent.

    Usage::

        bot = Nanobot.from_config()
        result = await bot.run("Summarize this repo", hooks=[MyHook()])
        print(result.content)
    """

    def __init__(self, loop: AgentLoop) -> None:
        self._loop = loop

    @classmethod
    def from_config(
        cls,
        config_path: str | Path | None = None,
        *,
        workspace: str | Path | None = None,
    ) -> Nanobot:
        """Create a Nanobot instance from a config file.

        Args:
            config_path: Path to ``config.json``.  Defaults to
                ``~/.nanobot/config.json``.
            workspace: Override the workspace directory from config.
        """
        config = _resolve_config(config_path, workspace)
        return cls(_build_agent_loop(config))

    async def run(
        self,
        message: str,
        *,
        session_key: str = "sdk:default",
        hooks: list[AgentHook] | None = None,
    ) -> RunResult:
        """Run the agent once and return the result.

        Args:
            message: The user message to process.
            session_key: Session identifier for conversation isolation.
                Different keys get independent history.
            hooks: Optional lifecycle hooks for this run.
        """
        prev = self._loop._extra_hooks
        if hooks is not None:
            self._loop._extra_hooks = list(hooks)
        try:
            response = await self._loop.process_direct(
                message,
                session_key=session_key,
            )
        finally:
            self._loop._extra_hooks = prev

        content = (response.content if response else None) or ""
        return RunResult(content=content, tools_used=[], messages=[])


def _make_provider(config: Any) -> Any:
    """Backwards-compat shim around :func:`nanobot.providers.factory.build_provider`."""
    from nanobot.providers.factory import build_provider

    return build_provider(config, attach_token_usage=False)
