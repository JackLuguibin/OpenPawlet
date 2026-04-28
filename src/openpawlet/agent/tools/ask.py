"""Tool for pausing a turn until the user answers."""

import json
from typing import Any

from openpawlet.agent.tools.base import Tool, tool_parameters
from openpawlet.agent.tools.schema import ArraySchema, StringSchema, tool_parameters_schema

# Channels that can render the ask_user options as native button rows.
# Other channels splice the options into the message body so the user
# always sees the choices regardless of client capabilities.
BUTTON_CHANNELS = frozenset({"telegram"})


class AskUserInterrupt(BaseException):
    """Internal signal: the runner should stop and wait for user input.

    Subclasses ``BaseException`` (not ``Exception``) so that generic
    ``except Exception`` clauses in tools and the runner do not swallow
    it — the interrupt has to bubble up to ``AgentRunner._execute_tools``
    where the loop is decided.
    """

    def __init__(self, question: str, options: list[str] | None = None) -> None:
        self.question = question
        self.options = [str(option) for option in (options or []) if str(option)]
        super().__init__(question)


@tool_parameters(
    tool_parameters_schema(
        question=StringSchema(
            "The question to ask before continuing. "
            "Use this only when the task needs the user's answer."
        ),
        options=ArraySchema(
            StringSchema("A possible answer label"),
            description="Optional choices. The user may still reply with free text.",
        ),
        required=["question"],
    )
)
class AskUserTool(Tool):
    """Ask the user a blocking question."""

    @property
    def name(self) -> str:
        return "ask_user"

    @property
    def description(self) -> str:
        return (
            "Pause and ask the user a question when their answer is required to continue. "
            "Use options for likely answers; the user's reply, typed or selected, is "
            "returned as the tool result. "
            "For non-blocking notifications or buttons, use the message tool instead."
        )

    @property
    def exclusive(self) -> bool:
        return True

    async def execute(self, question: str, options: list[str] | None = None, **_: Any) -> Any:
        raise AskUserInterrupt(question=question, options=options)


# ---------------------------------------------------------------------------
# Helpers used by AgentLoop to keep ask_user logic out of the loop body.
# ---------------------------------------------------------------------------


def _tool_call_name(tool_call: dict[str, Any]) -> str:
    function = tool_call.get("function")
    if isinstance(function, dict) and isinstance(function.get("name"), str):
        return function["name"]
    name = tool_call.get("name")
    return name if isinstance(name, str) else ""


def _tool_call_arguments(tool_call: dict[str, Any]) -> dict[str, Any]:
    function = tool_call.get("function")
    raw = function.get("arguments") if isinstance(function, dict) else tool_call.get("arguments")
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def pending_ask_user_id(history: list[dict[str, Any]]) -> str | None:
    """Return the tool_call_id of an unanswered ``ask_user`` call, if any.

    A call is considered "pending" when the assistant message issued it
    but no matching tool result has been recorded yet.  Used by
    :class:`AgentLoop` to feed the user's next reply back as the missing
    tool result instead of starting a fresh user turn.
    """
    pending: dict[str, str] = {}
    for message in history:
        if message.get("role") == "assistant":
            for tool_call in message.get("tool_calls") or []:
                if isinstance(tool_call, dict) and isinstance(tool_call.get("id"), str):
                    pending[tool_call["id"]] = _tool_call_name(tool_call)
        elif message.get("role") == "tool":
            tool_call_id = message.get("tool_call_id")
            if isinstance(tool_call_id, str):
                pending.pop(tool_call_id, None)
    for tool_call_id, name in reversed(pending.items()):
        if name == "ask_user":
            return tool_call_id
    return None


def ask_user_tool_result_messages(
    system_prompt: str,
    history: list[dict[str, Any]],
    tool_call_id: str,
    content: str,
) -> list[dict[str, Any]]:
    """Build the message list that resumes a turn after the user answered.

    The user's reply is delivered as the missing tool result so the model
    sees a clean ``assistant(tool_call) -> tool(result)`` pairing instead
    of an extra free-floating user turn that would re-trigger the model.
    """
    return [
        {"role": "system", "content": system_prompt},
        *history,
        {
            "role": "tool",
            "tool_call_id": tool_call_id,
            "name": "ask_user",
            "content": content,
        },
    ]


def ask_user_options_from_messages(messages: list[dict[str, Any]]) -> list[str]:
    """Extract the most recent ``ask_user`` options from an outgoing message list."""
    for message in reversed(messages):
        if message.get("role") != "assistant":
            continue
        for tool_call in reversed(message.get("tool_calls") or []):
            if not isinstance(tool_call, dict) or _tool_call_name(tool_call) != "ask_user":
                continue
            options = _tool_call_arguments(tool_call).get("options")
            if isinstance(options, list):
                return [str(option) for option in options if isinstance(option, str)]
    return []


def ask_user_outbound(
    content: str | None,
    options: list[str],
    channel: str,
) -> tuple[str | None, list[list[str]]]:
    """Render an ``ask_user`` outbound for *channel*.

    Channels in :data:`BUTTON_CHANNELS` get native button rows.  Other
    channels splice the options into the message text as a numbered list
    so users always see the available choices.
    """
    if not options:
        return content, []
    if channel in BUTTON_CHANNELS:
        return content, [options]
    option_text = "\n".join(f"{index}. {option}" for index, option in enumerate(options, 1))
    return f"{content}\n\n{option_text}" if content else option_text, []
