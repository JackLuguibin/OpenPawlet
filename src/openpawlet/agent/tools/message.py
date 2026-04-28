"""Message tool for sending messages to users."""

from collections.abc import Awaitable, Callable
from contextvars import ContextVar
from typing import Any

from openpawlet.agent.tools.base import Tool, tool_parameters
from openpawlet.agent.tools.schema import ArraySchema, StringSchema, tool_parameters_schema
from openpawlet.bus.events import OutboundMessage


@tool_parameters(
    tool_parameters_schema(
        content=StringSchema("The message content to send"),
        channel=StringSchema("Optional: target channel (telegram, discord, etc.)"),
        chat_id=StringSchema("Optional: target chat/user ID"),
        media=ArraySchema(
            StringSchema(""),
            description="Optional: list of file paths to attach (images, audio, documents)",
        ),
        buttons=ArraySchema(
            ArraySchema(StringSchema("")),
            description=(
                "Optional: list of rows of button labels offered as quick replies. "
                "Channels that support inline keyboards render natively; otherwise "
                "the labels are spliced into the message text as ``[label]`` chips."
            ),
        ),
        required=["content"],
    )
)
class MessageTool(Tool):
    """Tool to send messages to users on chat channels."""

    def __init__(
        self,
        send_callback: Callable[[OutboundMessage], Awaitable[None]] | None = None,
        default_channel: str = "",
        default_chat_id: str = "",
        default_message_id: str | None = None,
    ):
        self._send_callback = send_callback
        self._default_channel = default_channel
        self._default_chat_id = default_chat_id
        self._default_message_id = default_message_id
        self._sent_in_turn: bool = False
        self._channel_ctx: ContextVar[str | None] = ContextVar("message_tool_channel", default=None)
        self._chat_id_ctx: ContextVar[str | None] = ContextVar("message_tool_chat_id", default=None)
        self._message_id_ctx: ContextVar[str | None] = ContextVar(
            "message_tool_message_id", default=None
        )
        # When active (e.g. inside a cron callback), tool-sent messages are
        # marked as proactive deliveries so the gateway can mirror them into
        # the channel session. Default off — normal user turns must not
        # double-record because AgentLoop already saves the assistant turn.
        self._record_channel_delivery_var: ContextVar[bool] = ContextVar(
            "message_tool_record_channel_delivery", default=False
        )

    def set_context(self, channel: str, chat_id: str, message_id: str | None = None) -> None:
        """Set the current message context (task-local when running under asyncio)."""
        self._channel_ctx.set(channel)
        self._chat_id_ctx.set(chat_id)
        self._message_id_ctx.set(message_id)

    def set_send_callback(self, callback: Callable[[OutboundMessage], Awaitable[None]]) -> None:
        """Set the callback for sending messages."""
        self._send_callback = callback

    def start_turn(self) -> None:
        """Reset per-turn send tracking."""
        self._sent_in_turn = False

    def set_record_channel_delivery(self, active: bool):
        """Mark tool-sent messages as proactive channel deliveries.

        Returns a contextvars token that callers must pass back to
        :meth:`reset_record_channel_delivery` once the proactive scope
        is over (e.g. cron job has finished).
        """
        return self._record_channel_delivery_var.set(active)

    def reset_record_channel_delivery(self, token) -> None:
        """Restore previous proactive delivery recording state."""
        self._record_channel_delivery_var.reset(token)

    @property
    def name(self) -> str:
        return "message"

    @property
    def description(self) -> str:
        return (
            "Send a message to the user, optionally with file attachments. "
            "This is the ONLY way to deliver files (images, documents, audio, video) to the user. "
            "Use the 'media' parameter with file paths to attach files. "
            "Do NOT use read_file to send files — that only reads content for your own analysis."
        )

    @staticmethod
    def _normalize_buttons(buttons: Any) -> list[list[str]] | str:
        """Validate *buttons* and return a normalized ``list[list[str]]``.

        Returns an error message string when *buttons* is malformed so the
        agent gets a clear contract violation instead of letting bad data
        hit the channel layer (where Telegram would silently 400 the send).
        Empty / None inputs return ``[]`` so callers stay simple.
        """
        if buttons is None:
            return []
        if not isinstance(buttons, list):
            return "Error: buttons must be a list of list of strings"
        normalized: list[list[str]] = []
        for row in buttons:
            if not isinstance(row, list):
                return "Error: buttons must be a list of list of strings"
            row_labels: list[str] = []
            for label in row:
                if not isinstance(label, str) or not label.strip():
                    return "Error: buttons must be a list of list of strings"
                row_labels.append(label)
            normalized.append(row_labels)
        return normalized

    @staticmethod
    def buttons_as_text(buttons: list[list[str]] | None) -> str:
        """Format *buttons* as ``[label1] [label2]`` per row, one row per line.

        Channels without native inline-keyboard support splice this text
        into the message body so the user always sees the available options.
        """
        if not buttons:
            return ""
        return "\n".join(" ".join(f"[{label}]" for label in row) for row in buttons if row)

    async def execute(
        self,
        content: str,
        channel: str | None = None,
        chat_id: str | None = None,
        message_id: str | None = None,
        media: list[str] | None = None,
        buttons: list[list[str]] | None = None,
        **kwargs: Any,
    ) -> str:
        from openpawlet.utils.helpers import strip_think

        content = strip_think(content)

        normalized_buttons = self._normalize_buttons(buttons)
        if isinstance(normalized_buttons, str):
            return normalized_buttons

        ctx_ch = self._channel_ctx.get()
        ctx_chat = self._chat_id_ctx.get()
        ref_ch = self._default_channel if ctx_ch is None else ctx_ch
        ref_chat = self._default_chat_id if ctx_chat is None else ctx_chat

        channel = channel or ref_ch
        chat_id = chat_id or ref_chat
        # Only inherit default message_id when targeting the same channel+chat.
        # Cross-chat sends must not carry the original message_id, because
        # some channels (e.g. Feishu) use it to determine the target
        # conversation via their Reply API, which would route the message
        # to the wrong chat entirely.
        if channel == ref_ch and chat_id == ref_chat:
            ctx_mid = self._message_id_ctx.get()
            message_id = message_id or (self._default_message_id if ctx_mid is None else ctx_mid)
        else:
            message_id = None

        if not channel or not chat_id:
            return "Error: No target channel/chat specified"

        if not self._send_callback:
            return "Error: Message sending not configured"

        metadata: dict[str, Any] = {"message_id": message_id} if message_id else {}
        if self._record_channel_delivery_var.get():
            metadata["_record_channel_delivery"] = True

        msg = OutboundMessage(
            channel=channel,
            chat_id=chat_id,
            content=content,
            media=media or [],
            metadata=metadata,
            buttons=normalized_buttons,
        )

        try:
            await self._send_callback(msg)
            if channel == ref_ch and chat_id == ref_chat:
                self._sent_in_turn = True
            media_info = f" with {len(media)} attachments" if media else ""
            buttons_info = (
                f" with {sum(len(r) for r in normalized_buttons)} button(s)"
                if normalized_buttons
                else ""
            )
            return f"Message sent to {channel}:{chat_id}{media_info}{buttons_info}"
        except Exception as e:
            return f"Error sending message: {str(e)}"
