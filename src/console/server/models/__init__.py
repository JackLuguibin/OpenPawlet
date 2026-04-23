"""Pydantic models for request bodies and response payloads."""

from __future__ import annotations

from console.server.models.activity import ActivityItem
from console.server.models.agents import (
    AddCategoryBody,
    Agent,
    AgentCreateRequest,
    AgentsSystemStatus,
    AgentStatus,
    AgentUpdateRequest,
    BroadcastEventRequest,
    CategoryInfo,
    CategoryOverrideBody,
    DelegateTaskRequest,
    DelegateTaskResponse,
)
from console.server.models.alerts import Alert
from console.server.models.base import (
    BaseResponse,
    DataResponse,
    OkBody,
    OkWithAgentId,
    OkWithJobId,
    OkWithKey,
    OkWithName,
    OkWithPath,
    OkWithTopic,
)
from console.server.models.bot_files import BotFilesResponse, BotFileUpdateBody
from console.server.models.bots import (
    BotInfo,
    CreateBotRequest,
    SetDefaultBotBody,
)
from console.server.models.chat import ChatRequest, ChatResponse, ToolCall
from console.server.models.config import (
    ConfigPutBody,
    ConfigSection,
    ConfigValidateResponse,
)
from console.server.models.cron import CronAddRequest, CronJob, CronStatus
from console.server.models.echo import EchoRequest, EchoResponse
from console.server.models.env import EnvPutBody, EnvPutResponse, EnvResponse
from console.server.models.errors import ErrorDetail, ErrorResponse
from console.server.models.health import HealthResponse
from console.server.models.health_audit import HealthAuditResponse, HealthIssue
from console.server.models.memory import MemoryResponse
from console.server.models.observability import (
    AgentObservabilityEvent,
    AgentObservabilityTimeline,
    ConsoleObservabilityInfo,
    NanobotGatewayInfo,
    ObservabilityResponse,
)
from console.server.models.runtime_logs import RuntimeLogChunk, RuntimeLogsData
from console.server.models.sessions import (
    BatchDeleteBody,
    BatchDeleteFailure,
    BatchDeleteResponse,
    CreateSessionBody,
    SessionDetail,
    SessionInfo,
    SessionJsonlRawPayload,
    SessionMessagesPayload,
)
from console.server.models.skills import (
    InstallFromRegistryBody,
    RegistrySearchItem,
    SkillBundleUpdateBody,
    SkillContentBody,
    SkillContentResponse,
    SkillCreateBody,
    SkillInfo,
)
from console.server.models.status import StatusResponse
from console.server.models.tools import ToolCallLog
from console.server.models.usage import UsageHistoryItem
from console.server.models.workspace import (
    WorkspaceFilePutBody,
    WorkspaceFileResponse,
    WorkspaceListResponse,
)

__all__ = [
    "ActivityItem",
    "AddCategoryBody",
    "Agent",
    "AgentCreateRequest",
    "AgentsSystemStatus",
    "AgentStatus",
    "AgentUpdateRequest",
    "Alert",
    "BaseResponse",
    "BatchDeleteBody",
    "BatchDeleteFailure",
    "BatchDeleteResponse",
    "BotFilesResponse",
    "BotFileUpdateBody",
    "BotInfo",
    "BroadcastEventRequest",
    "CategoryInfo",
    "CategoryOverrideBody",
    "ChatRequest",
    "ChatResponse",
    "ConfigPutBody",
    "ConfigSection",
    "ConfigValidateResponse",
    "CreateBotRequest",
    "CreateSessionBody",
    "CronAddRequest",
    "CronJob",
    "CronStatus",
    "DataResponse",
    "DelegateTaskRequest",
    "DelegateTaskResponse",
    "EchoRequest",
    "EchoResponse",
    "EnvPutBody",
    "EnvPutResponse",
    "EnvResponse",
    "ErrorDetail",
    "ErrorResponse",
    "HealthAuditResponse",
    "HealthIssue",
    "HealthResponse",
    "InstallFromRegistryBody",
    "MemoryResponse",
    "AgentObservabilityEvent",
    "AgentObservabilityTimeline",
    "ConsoleObservabilityInfo",
    "NanobotGatewayInfo",
    "ObservabilityResponse",
    "OkBody",
    "OkWithAgentId",
    "OkWithJobId",
    "OkWithKey",
    "OkWithName",
    "OkWithPath",
    "OkWithTopic",
    "RegistrySearchItem",
    "RuntimeLogChunk",
    "RuntimeLogsData",
    "SessionDetail",
    "SessionInfo",
    "SessionJsonlRawPayload",
    "SessionMessagesPayload",
    "SetDefaultBotBody",
    "SkillBundleUpdateBody",
    "SkillContentBody",
    "SkillContentResponse",
    "SkillCreateBody",
    "SkillInfo",
    "StatusResponse",
    "ToolCall",
    "ToolCallLog",
    "UsageHistoryItem",
    "WorkspaceFilePutBody",
    "WorkspaceFileResponse",
    "WorkspaceListResponse",
]
