"""Spawn tool for creating background subagents."""

from contextvars import ContextVar
from typing import TYPE_CHECKING, Any

from openpawlet.agent.tools.base import Tool, tool_parameters
from openpawlet.agent.tools.schema import StringSchema, tool_parameters_schema

if TYPE_CHECKING:
    from openpawlet.agent.subagent import SubagentManager


@tool_parameters(
    tool_parameters_schema(
        task=StringSchema("The task for the subagent to complete"),
        label=StringSchema("Optional short label for the task (for display)"),
        profile=StringSchema(
            "Optional sub-agent profile id (workspace/agents/<id>/). "
            "When set, the sub-agent runs with that profile's persona, "
            "model, and tool whitelist instead of the main agent's."
        ),
        required=["task"],
    )
)
class SpawnTool(Tool):
    """Tool to spawn a subagent for background task execution."""

    def __init__(self, manager: "SubagentManager"):
        self._manager = manager
        self._default_origin_channel = "cli"
        self._default_origin_chat_id = "direct"
        self._default_session_key = "cli:direct"
        self._origin_channel_ctx: ContextVar[str | None] = ContextVar(
            "spawn_origin_channel", default=None
        )
        self._origin_chat_id_ctx: ContextVar[str | None] = ContextVar(
            "spawn_origin_chat_id", default=None
        )
        self._session_key_ctx: ContextVar[str | None] = ContextVar(
            "spawn_session_key", default=None
        )

    def set_context(self, channel: str, chat_id: str, effective_key: str | None = None) -> None:
        """Set the origin context for subagent announcements (task-local under asyncio)."""
        self._origin_channel_ctx.set(channel)
        self._origin_chat_id_ctx.set(chat_id)
        self._session_key_ctx.set(effective_key or f"{channel}:{chat_id}")

    @property
    def name(self) -> str:
        return "spawn"

    @property
    def description(self) -> str:
        return (
            "Spawn a subagent to handle a task in the background. "
            "Use this for complex or time-consuming tasks that can run independently. "
            "The subagent will complete the task and report back when done. "
            "Pass `profile` to run the sub-agent with an independent persona "
            "(separate SOUL/USER/AGENTS/TOOLS, model, and tool whitelist) "
            "configured at workspace/agents/<id>/. "
            "Omit `profile` to inherit the main agent's settings. "
            "For deliverables or existing projects, inspect the workspace first "
            "and use a dedicated subdirectory when helpful."
        )

    async def execute(
        self,
        task: str,
        label: str | None = None,
        profile: str | None = None,
        **kwargs: Any,
    ) -> str:
        """Spawn a subagent to execute the given task."""
        oc = self._origin_channel_ctx.get()
        och = self._origin_chat_id_ctx.get()
        sk = self._session_key_ctx.get()
        origin_channel = self._default_origin_channel if oc is None else oc
        origin_chat_id = self._default_origin_chat_id if och is None else och
        session_key = self._default_session_key if sk is None else sk
        return await self._manager.spawn(
            task=task,
            label=label,
            origin_channel=origin_channel,
            origin_chat_id=origin_chat_id,
            session_key=session_key,
            profile_id=(profile.strip() if isinstance(profile, str) and profile.strip() else None),
        )
