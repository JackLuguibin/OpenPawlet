import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import { flushSync } from "react-dom";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../store";
import {
  disconnectOpenPawletChannelWebSocket,
  resolveOpenPawletWsBase,
  tryParseOpenPawletResumeChatId,
  useOpenPawletChannelWebSocket,
} from "../hooks/useOpenPawletChannelWebSocket";
import type { ChatChunkSource } from "../hooks/useWebSocket";
import { registerChatHandler, getWSRef } from "../hooks/useWebSocket";
import { useAgentTimeZone } from "../hooks/useAgentTimeZone";
import { formatChatMessageTime } from "../utils/agentDatetime";
import * as api from "../api/client";
import { Button, Popconfirm, Checkbox, Spin, Modal, Select, Tabs, Switch, Tooltip } from "antd";
import {
  PlusOutlined,
  LoadingOutlined,
  DeleteOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  RobotOutlined,
  CheckCircleOutlined,
  DownOutlined,
  RightOutlined,
  CopyOutlined,
  ApiOutlined,
  MessageOutlined,
  CloseOutlined,
  FileTextOutlined,
} from "@ant-design/icons";
import type { SessionInfo, StreamChunk, ToolCall } from "../api/types";
import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { EditorView } from "@codemirror/view";
import { vscodeDark, vscodeLight } from "@uiw/codemirror-theme-vscode";
import type { TextAreaRef } from "antd/es/input/TextArea";
import Input from "antd/es/input";
import { SubagentPanel, type SubagentTask } from "../components/SubagentPanel";
import { MessageRow } from "./chat/MessageRow";
import { VirtualizedMessageList } from "./chat/VirtualizedMessageList";
import { useVirtualListHandle } from "./chat/useVirtualListHandle";
import type { Message, TrackedToolCall } from "./chat/types";
import {
  parseOpenPawletStatusFromChunk,
  parseOpenPawletStatusPlainText,
  resolveChatDonePrimaryText,
  streamChunkText,
} from "./chat/statusParse";
import {
  groupAssistantReplies,
  mergeStreamingToolCalls,
  mergeToolResultsIntoAssistantMessages,
  normalizeMessageForChatRender,
} from "./chat/replyGroup";
import {
  formatJsonlForDisplay,
  isSessionMissingError,
  LAST_CONSOLE_SESSION_STORAGE_KEY,
  OPENPAWLET_CHAT_NEW_INTENT_STORAGE_KEY,
  pickLatestActiveSessionKey,
  readOpenPawletChatNewIntent,
} from "./chat/sessionUtils";
import { MessageToolCallsBlock } from "./chat/MessageToolCalls";
import { MessageThinkingBlock } from "./chat/MessageThinkingBlock";
import { ChatInput } from "./chat/ChatInput";
import { ChatHeroSuggestions } from "./chat/ChatHeroSuggestions";
import { JumpToBottomButton } from "./chat/JumpToBottomButton";
import { StreamingAssistantBubble } from "./chat/StreamingAssistantBubble";
import { SessionSidebarItem } from "./chat/SessionSidebarItem";
import { useOpenPawletContextUsage } from "./chat/useOpenPawletContextUsage";
import {
  CHAT_HISTORY_PAGE_SIZE,
  CHAT_HISTORY_TOP_TRIGGER_PX,
  useChatHistoryPaging,
} from "./chat/useChatHistoryPaging";

/** Near-bottom threshold (mirrors the pre-virtualization scroll sticky rule). */
const CHAT_NEAR_BOTTOM_PX = 100;

export default function Chat() {
  const { t, i18n } = useTranslation();
  const { sessionKey: paramSessionKey } = useParams();
  const resumeOpenPawletChatUuid = useMemo(
    () => tryParseOpenPawletResumeChatId(paramSessionKey),
    [paramSessionKey],
  );
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { currentSessionKey, setCurrentSessionKey, currentBotId, addToast } =
    useAppStore();
  const openpawletClientId = useAppStore((s) => s.openpawletClientId);
  const wsConnected = useAppStore((s) => s.wsConnected);
  const agentTz = useAgentTimeZone();

  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const isStreamingRef = useRef(false);
  /** True when `isStreaming` was set from OpenPawlet WS `ready.session_busy` (turn in flight on server). */
  const streamingPrimedByServerRef = useRef(false);
  useEffect(() => {
    isStreamingRef.current = isStreaming;
  }, [isStreaming]);
  /** One assistant reply per user turn; drop duplicate chat_done (e.g. stream_end + chat_end). */
  const assistantReplyFinalizedRef = useRef(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [sessionsSidebarOpen, setSessionsSidebarOpen] = useState(false);
  const [sessionsSidebarCollapsed, setSessionsSidebarCollapsed] =
    useState(false);
  const [sessionTreeExpanded, setSessionTreeExpanded] = useState<{
    main: boolean;
    teams: boolean;
    subagents: boolean;
  }>({
    main: true,
    teams: false,
    subagents: false,
  });
  const [expandedSubAgents, setExpandedSubAgents] = useState<Set<string>>(
    () => new Set(),
  );
  const [batchSelectedKeys, setBatchSelectedKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const [toolCalls, setToolCalls] = useState<TrackedToolCall[]>([]);
  /** OpenPawlet WebSocket 帧中的 tool_calls / reasoning_content（与正文并行展示） */
  const [streamingPayloadToolCalls, setStreamingPayloadToolCalls] = useState<
    ToolCall[]
  >([]);
  const [streamingReasoningContent, setStreamingReasoningContent] =
    useState<string>("");
  const streamingPayloadToolCallsRef = useRef<ToolCall[]>([]);
  const streamingReasoningContentRef = useRef<string>("");
  /**
   * Server-issued reply_group_id observed on the current streaming turn.
   * The runtime stamps this UUID on every WS frame for one Agent reply, so
   * we keep the first non-empty value seen and apply it to the assistant
   * bubble we materialize on chat_done. Reset on chat_done / new turn.
   */
  const streamingReplyGroupIdRef = useRef<string | null>(null);
  /** 流式过程中后端单独下发的工具调用摘要（与正文 Markdown 分离） */
  const [streamingToolProgress, setStreamingToolProgress] = useState<string[]>(
    [],
  );
  /** OpenPawlet `event: message` (retries, status) until `chat_end` */
  const [streamingChannelNotices, setStreamingChannelNotices] = useState<
    string[]
  >([]);
  const [showSuggestions, setShowSuggestions] = useState(true);
  const [subagentTasks, setSubagentTasks] = useState<SubagentTask[]>([]);
  const [subagentPanelOpen, setSubagentPanelOpen] = useState(true);
  // Sub-agent transcripts surface as their own ``subagent:<parent>:<task_id>``
  // sessions; hide them from the main sidebar by default and let the user
  // toggle visibility (preference is persisted in localStorage).
  const [showSubagentSessions, setShowSubagentSessions] = useState<boolean>(
    () => {
      try {
        return (
          localStorage.getItem("openpawlet:showSubagentSessions") === "1"
        );
      } catch {
        return false;
      }
    },
  );
  useEffect(() => {
    try {
      localStorage.setItem(
        "openpawlet:showSubagentSessions",
        showSubagentSessions ? "1" : "0",
      );
    } catch {
      // ignore (storage may be unavailable in private mode)
    }
  }, [showSubagentSessions]);
  const [sessionSidebarDisplayMode, setSessionSidebarDisplayMode] = useState<
    "compact" | "detail"
  >(() => {
    try {
      const raw = localStorage.getItem("openpawlet:sessionSidebarDisplayMode");
      return raw === "compact" ? "compact" : "detail";
    } catch {
      return "detail";
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(
        "openpawlet:sessionSidebarDisplayMode",
        sessionSidebarDisplayMode,
      );
    } catch {
      // ignore (storage may be unavailable in private mode)
    }
  }, [sessionSidebarDisplayMode]);
  const isSessionDetailMode = sessionSidebarDisplayMode === "detail";
  const [sessionJsonlModalOpen, setSessionJsonlModalOpen] = useState(false);
  const [renameSessionModalOpen, setRenameSessionModalOpen] = useState(false);
  const [renameSessionKey, setRenameSessionKey] = useState<string | null>(null);
  const [renameSessionTitle, setRenameSessionTitle] = useState("");
  const [sessionJsonlFileSource, setSessionJsonlFileSource] = useState<
    "session" | "transcript"
  >("session");
  const [sessionContextTab, setSessionContextTab] = useState<
    "assembled" | "raw"
  >("assembled");
  const jsonlViewTheme = useAppStore((s) => s.theme);
  const [codeMirrorIsDark, setCodeMirrorIsDark] = useState(false);
  useEffect(() => {
    if (jsonlViewTheme === "light") {
      setCodeMirrorIsDark(false);
      return;
    }
    if (jsonlViewTheme === "dark") {
      setCodeMirrorIsDark(true);
      return;
    }
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    setCodeMirrorIsDark(mq.matches);
    const onChange = () => setCodeMirrorIsDark(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [jsonlViewTheme]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  /** When false, new tokens must not force scroll (user scrolled up to read). */
  const messagesStickToBottomRef = useRef(true);
  /** Imperative handle into the virtualized message list (scroll helpers). */
  const [virtualListHandleRef, setVirtualListHandle] = useVirtualListHandle();
  /** Tracks unseen new-message count while the user is scrolled away from the bottom. */
  const [unreadBelowCount, setUnreadBelowCount] = useState(0);
  /** Drives the "jump to bottom" button visibility; updated from scroll events. */
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const inputRef = useRef<TextAreaRef>(null);
  const streamingContentRef = useRef("");
  /** Coalesce high-frequency chat_token updates to one setState per animation frame */
  const streamTokenFlushRafRef = useRef<number | null>(null);
  const pendingStreamTokenDeltaRef = useRef("");
  /** Throttle transcript refetch triggered by in-flight tool events. */
  const transcriptSyncTimerRef = useRef<number | null>(null);
  /** 新会话首条消息：等待 OpenPawlet 内置 websocket 通道连接后再发送 */
  const pendingOpenPawletOutboundRef = useRef<string | null>(null);

  /** Cancel scheduled rAF and apply any buffered tokens so state matches streamingContentRef */
  const cancelStreamTokenFlush = useCallback(() => {
    if (streamTokenFlushRafRef.current !== null) {
      cancelAnimationFrame(streamTokenFlushRafRef.current);
      streamTokenFlushRafRef.current = null;
    }
    const delta = pendingStreamTokenDeltaRef.current;
    pendingStreamTokenDeltaRef.current = "";
    if (delta) {
      setStreamingContent((prev) => prev + delta);
    }
  }, []);

  const cancelTranscriptSync = useCallback(() => {
    if (transcriptSyncTimerRef.current !== null) {
      window.clearTimeout(transcriptSyncTimerRef.current);
      transcriptSyncTimerRef.current = null;
    }
  }, []);

  const activeSessionKey = paramSessionKey || currentSessionKey;

  /**
   * Throttled transcript refetch triggered by inflight tool events. Backend now
   * appends tool_calls / tool results to the transcript immediately, so pulling
   * `/sessions/:key/transcript` mid-turn surfaces them without waiting for
   * `chat_done`. Coalesces bursts to at most one refetch per 1.5s.
   */
  const scheduleTranscriptSync = useCallback(() => {
    if (!activeSessionKey) {
      return;
    }
    if (transcriptSyncTimerRef.current !== null) {
      return;
    }
    transcriptSyncTimerRef.current = window.setTimeout(() => {
      transcriptSyncTimerRef.current = null;
      queryClient.invalidateQueries({
        queryKey: ["session", activeSessionKey, currentBotId],
      });
    }, 1500);
  }, [activeSessionKey, currentBotId, queryClient]);

  useEffect(() => {
    messagesStickToBottomRef.current = true;
    streamingPrimedByServerRef.current = false;
  }, [activeSessionKey]);

  const openpawletWsBase = resolveOpenPawletWsBase();
  const useOpenPawletChannel = openpawletWsBase.length > 0;

  const {
    data: sessions,
    isPending: sessionsListPending,
    isError: sessionsListError,
  } = useQuery({
    queryKey: ["sessions", currentBotId],
    queryFn: () => api.listSessions(currentBotId),
  });

  // Console multi-agent records — used to display human-friendly names for
  // the Sub Agents grouping in the sidebar (id → name).
  const { data: consoleAgents } = useQuery({
    queryKey: ["agents", currentBotId],
    queryFn: () => api.listAgents(currentBotId!),
    enabled: !!currentBotId,
  });

  // Live runtime agents (main + subagent tasks): `/ws/state` ->
  // `runtime_agents_update` updates the cache; HTTP fallback only offline.
  const { data: runtimeAgents } = useQuery({
    queryKey: ["runtime-agents", currentBotId],
    queryFn: () => api.listRuntimeAgents(),
    staleTime: wsConnected ? Number.POSITIVE_INFINITY : 0,
    refetchInterval: wsConnected ? false : 30_000,
    refetchOnWindowFocus: !wsConnected,
  });

  useEffect(() => {
    if (!sessions?.length) {
      setBatchSelectedKeys((prev) => (prev.size === 0 ? prev : new Set()));
      return;
    }
    const validKeys = new Set(sessions.map((s) => s.key));
    setBatchSelectedKeys((prev) => {
      const next = new Set([...prev].filter((k) => validKeys.has(k)));
      return next.size === prev.size ? prev : next;
    });
  }, [sessions]);

  const onBareOpenPawletChatRoute =
    useOpenPawletChannel && paramSessionKey === undefined;
  // Bare `/chat` should not eagerly open a WebSocket: doing so makes the
  // OpenPawlet agent loop materialize an in-memory Session on the very first
  // `/status` poll triggered after `ready`, which the SessionManager later
  // flushes to disk as an empty `sessions/*.jsonl` file (visible as a
  // ghost row in the sidebar after every backend restart). Only connect
  // when the user has explicitly opted into a new chat or when an
  // existing route is being resumed (`/chat/:key`).
  const openpawletChannelWsEnabled =
    useOpenPawletChannel &&
    (!onBareOpenPawletChatRoute ||
      (!sessionsListPending &&
        (sessionsListError || readOpenPawletChatNewIntent())));

  useEffect(() => {
    if (paramSessionKey === undefined) {
      return;
    }
    try {
      sessionStorage.removeItem(OPENPAWLET_CHAT_NEW_INTENT_STORAGE_KEY);
    } catch {
      // ignore
    }
  }, [paramSessionKey]);

  useEffect(() => {
    if (!useOpenPawletChannel) {
      return;
    }
    const routeKey = paramSessionKey?.trim();
    if (routeKey) {
      useAppStore.getState().setOpenPawletClientId(routeKey);
    }
  }, [useOpenPawletChannel, paramSessionKey]);

  /**
   * After the session list loads, open the last-opened session if still present;
   * otherwise the newest-created row in the list. Skip when starting a blank
   * "New chat" (storage flag) or when there are no sessions (new WS chat).
   */
  useEffect(() => {
    if (!useOpenPawletChannel) {
      return;
    }
    if (paramSessionKey !== undefined) {
      return;
    }
    if (sessionsListPending || sessionsListError) {
      return;
    }
    const list = sessions ?? [];
    if (list.length === 0) {
      return;
    }
    if (readOpenPawletChatNewIntent()) {
      return;
    }
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(LAST_CONSOLE_SESSION_STORAGE_KEY);
    } catch {
      return;
    }
    const storedKey = stored?.trim() ?? "";
    const keys = new Set(list.map((row) => row.key));
    const fallback = pickLatestActiveSessionKey(list);
    if (!fallback) {
      return;
    }
    const pick =
      storedKey.length > 0 && keys.has(storedKey) ? storedKey : fallback;
    navigate(`/chat/${encodeURIComponent(pick)}`, { replace: true });
  }, [
    useOpenPawletChannel,
    paramSessionKey,
    sessionsListPending,
    sessionsListError,
    sessions,
    navigate,
  ]);

  useEffect(() => {
    if (!useOpenPawletChannel || !activeSessionKey) {
      return;
    }
    const key = activeSessionKey.trim();
    if (!key) {
      return;
    }
    try {
      localStorage.setItem(LAST_CONSOLE_SESSION_STORAGE_KEY, key);
    } catch {
      // ignore quota / private mode
    }
  }, [useOpenPawletChannel, activeSessionKey]);

  /**
   * Bare `/chat` draft -> real session activation marker.
   * We only materialize a new session after the first outbound message, instead
   * of on socket `ready`, to match mainstream chat UX and avoid empty sessions.
   */
  const draftSessionActivationRequestedRef = useRef(false);
  const [draftSessionActivationTick, setDraftSessionActivationTick] = useState(0);

  /**
   * After deleting the current session, `navigate` is async while `useParams` still
   * holds the old key briefly; `activeSessionKey` would still match the deleted id
   * and trigger GET /sessions/:key/transcript → 404. Suppress history fetch until the route
   * param leaves that key.
   */
  const suppressSessionDetailForKeyRef = useRef<string | null>(null);
  /** Dedupe `createSession` + list invalidation when route/store deps churn with the same logical session. */
  const ensuredOpenPawletConsoleSessionRef = useRef<string | null>(null);

  const onOpenPawletReadySessionBusy = useCallback((busy: boolean) => {
    if (busy) {
      streamingPrimedByServerRef.current = true;
      setIsStreaming(true);
    } else if (streamingPrimedByServerRef.current) {
      streamingPrimedByServerRef.current = false;
      setIsStreaming(false);
    }
  }, []);

  const { sendMessage: sendOpenPawletMessage, ready: openpawletWsReady } =
    useOpenPawletChannelWebSocket({
      enabled: openpawletChannelWsEnabled,
      canonicalSessionKeyFromRoute: paramSessionKey ?? null,
      resumeChatId: resumeOpenPawletChatUuid,
      onReadySessionBusy: useOpenPawletChannel ? onOpenPawletReadySessionBusy : undefined,
    });

  /**
   * OpenPawlet `ready` 后由 `chat_id` 派生会话键 `websocket:<chat_id>`（见 `openpawletSessionKeyFromReadyChatId`）。
   * 仅在“用户已经发送过首条消息（草稿激活）+ 当前仍处 `/chat` 草稿态”时建立控制台
   * `sessions/*.jsonl` 并把路由同步为该键。这样可以避免 ws 重连/ready 抖动反复
   * 触发新会话，主流聊天产品的“首条消息落地一个会话”行为。
   */
  useEffect(() => {
    if (!useOpenPawletChannel || !openpawletClientId) {
      ensuredOpenPawletConsoleSessionRef.current = null;
      return;
    }
    if (!draftSessionActivationRequestedRef.current) {
      return;
    }
    if (paramSessionKey !== undefined) {
      // Already on /chat/:key — do not POST /sessions again, the file already
      // exists for this thread. Clear the activation marker so subsequent
      // ready frames are ignored.
      draftSessionActivationRequestedRef.current = false;
      return;
    }

    const dedupeKey = `${String(currentBotId ?? "")}:${openpawletClientId}`;
    if (ensuredOpenPawletConsoleSessionRef.current === dedupeKey) {
      return;
    }
    ensuredOpenPawletConsoleSessionRef.current = dedupeKey;

    void api
      .createSession(openpawletClientId, currentBotId)
      .then(() => {
        draftSessionActivationRequestedRef.current = false;
        queryClient.invalidateQueries({
          queryKey: ["sessions", currentBotId],
        });
        setCurrentSessionKey(openpawletClientId);
        navigate(`/chat/${encodeURIComponent(openpawletClientId)}`, {
          replace: true,
        });
        try {
          sessionStorage.removeItem(OPENPAWLET_CHAT_NEW_INTENT_STORAGE_KEY);
        } catch {
          // ignore
        }
      })
      .catch((err) => {
        ensuredOpenPawletConsoleSessionRef.current = null;
        console.error("[chat] createSession after first outbound", err);
      });
  }, [
    useOpenPawletChannel,
    openpawletClientId,
    currentBotId,
    paramSessionKey,
    navigate,
    setCurrentSessionKey,
    queryClient,
    draftSessionActivationTick,
  ]);

  const {
    openpawletContextUsage,
    setOpenPawletContextUsage,
    statusJsonLoading,
    scheduleOpenPawletStatusJson,
    silentStatusJsonRef,
    expectStatusJsonTrailingChatDoneRef,
    completeSilentStatusJsonPoll,
  } = useOpenPawletContextUsage({
    useOpenPawletChannel,
    openpawletWsReady,
    currentBotId,
    sendOpenPawletMessage,
    activeSessionKey,
  });

  /** Sidebar's "latest" row uses the same rule as navigation/delete fallbacks. */
  const latestSessionKeyForSidebar = useMemo(
    () => pickLatestActiveSessionKey(sessions ?? []),
    [sessions],
  );
  const groupedSessions = useMemo(() => {
    const list = sessions ?? [];
    const main: typeof list = [];
    const teams: typeof list = [];
    const subAgentRows = new Map<string, typeof list>();
    const subagentSessions: typeof list = [];
    for (const row of list) {
      if (row.is_subagent) {
        subagentSessions.push(row);
        continue;
      }
      if (row.team_id) {
        teams.push(row);
        continue;
      }
      // Sub-agent sessions are non-team sessions that have been associated
      // with a Console-defined agent (set when the session was created via
      // POST /sessions { agent_id }, or matched from the session key).
      if (row.agent_id) {
        const bucket = subAgentRows.get(row.agent_id) ?? [];
        bucket.push(row);
        subAgentRows.set(row.agent_id, bucket);
        continue;
      }
      main.push(row);
    }
    if (showSubagentSessions) {
      // When the toggle is on, treat sub-agent transcripts as a flat list at
      // the top level so users can navigate into them like any other session.
      main.push(...subagentSessions);
    }
    return { main, teams, subAgentRows, subagentSessions };
  }, [sessions, showSubagentSessions]);

  // Sub-Agents grouping: Console-agent id → { name, sessions, runtime tasks }.
  // We merge three signals: persisted sessions tagged with agent_id, the
  // server runtime status (refreshed every few seconds), and the WS-driven
  // ``subagentTasks`` list that captures very fresh spawn frames the
  // server may not have surfaced via the polling endpoint yet.
  const subAgentNodes = useMemo(() => {
    const nameById = new Map<string, string>();
    for (const a of consoleAgents ?? []) {
      nameById.set(a.id, a.name || a.id);
    }
    type Node = {
      key: string; // group key (Console agent id, profile id, or "__unbound__")
      name: string;
      sessions: typeof groupedSessions.main;
      tasks: Array<{
        id: string;
        label: string;
        status: "running" | "success" | "error";
        phase?: string | null;
        task?: string | null;
      }>;
    };
    const nodes = new Map<string, Node>();

    const ensure = (key: string, displayName?: string) => {
      let node = nodes.get(key);
      if (!node) {
        node = {
          key,
          name: displayName || key,
          sessions: [],
          tasks: [],
        };
        nodes.set(key, node);
      } else if (displayName && (!node.name || node.name === node.key)) {
        node.name = displayName;
      }
      return node;
    };

    for (const [agentId, rows] of groupedSessions.subAgentRows.entries()) {
      const node = ensure(agentId, nameById.get(agentId));
      node.sessions = rows;
    }

    const subRuntimeAgents = (runtimeAgents ?? []).filter(
      (r) => r.role === "sub",
    );
    for (const r of subRuntimeAgents) {
      const groupKey = r.profile_id || "__unbound__";
      const displayName = r.profile_id
        ? nameById.get(r.profile_id) || r.profile_id
        : t("chat.subAgentUnboundGroup", "Ad-hoc sub-agent tasks");
      const node = ensure(groupKey, displayName);
      const phase = r.phase || "";
      const status: "running" | "success" | "error" = r.running
        ? "running"
        : r.error || phase === "error" || r.stop_reason === "tool_error"
          ? "error"
          : "success";
      node.tasks.push({
        id: r.agent_id,
        label: r.label || r.agent_id,
        status,
        phase: r.phase ?? null,
        task: r.task_description ?? null,
      });
    }

    // Folding in WS-driven entries — they are running by the time we see them.
    const seenTaskIds = new Set(
      subRuntimeAgents.map((r) => r.agent_id.replace(/^sub:/, "")),
    );
    for (const wsTask of subagentTasks) {
      if (seenTaskIds.has(wsTask.id)) {
        continue;
      }
      const node = ensure(
        "__unbound__",
        t("chat.subAgentUnboundGroup", "Ad-hoc sub-agent tasks"),
      );
      node.tasks.push({
        id: `sub:${wsTask.id}`,
        label: wsTask.label,
        status: wsTask.status,
        phase: null,
        task: wsTask.task ?? null,
      });
    }

    // Sort: groups with running tasks first, then by name. Tasks: running first.
    const ordered = Array.from(nodes.values()).sort((a, b) => {
      const ra = a.tasks.some((task) => task.status === "running") ? 0 : 1;
      const rb = b.tasks.some((task) => task.status === "running") ? 0 : 1;
      if (ra !== rb) return ra - rb;
      return a.name.localeCompare(b.name);
    });
    for (const node of ordered) {
      node.tasks.sort((a, b) => {
        const ra = a.status === "running" ? 0 : 1;
        const rb = b.status === "running" ? 0 : 1;
        if (ra !== rb) return ra - rb;
        return a.label.localeCompare(b.label);
      });
    }
    return ordered;
  }, [
    groupedSessions,
    runtimeAgents,
    consoleAgents,
    subagentTasks,
    t,
  ]);

  const sessionSidebarRowRefs = useRef<Map<string, HTMLDivElement | null>>(
    new Map(),
  );
  const newChatSidebarScrollUntilRef = useRef(0);
  const [newChatSidebarScrollToken, setNewChatSidebarScrollToken] =
    useState(0);

  useEffect(() => {
    const until = newChatSidebarScrollUntilRef.current;
    if (!until || Date.now() > until) {
      return;
    }
    if (!sessions?.length) {
      return;
    }
    if (!sessionsSidebarOpen) {
      return;
    }
    if (sessionsSidebarCollapsed) {
      return;
    }

    const targetKey =
      openpawletClientId &&
      sessions.some((sessionRow) => sessionRow.key === openpawletClientId)
        ? openpawletClientId
        : latestSessionKeyForSidebar;
    if (!targetKey) {
      return;
    }

    const rowEl = sessionSidebarRowRefs.current.get(targetKey);
    if (!rowEl) {
      return;
    }

    const timer = window.setTimeout(() => {
      rowEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }, 320);

    return () => window.clearTimeout(timer);
  }, [
    sessions,
    openpawletClientId,
    latestSessionKeyForSidebar,
    sessionsSidebarOpen,
    sessionsSidebarCollapsed,
    newChatSidebarScrollToken,
  ]);

  const deleteSessionMutation = useMutation({
    mutationFn: async (key: string) => {
      const isDeletingCurrent = activeSessionKey === key;

      if (isDeletingCurrent) {
        /**
         * Required order for OpenPawlet:
         * 1) Hard-close WS so no `ready` is processed for the session being removed.
         * 2) flushSync + navigate to the next session (or bare /chat).
         * 3) DELETE the jsonl on the server.
         */
        if (useOpenPawletChannel) {
          disconnectOpenPawletChannelWebSocket();
        }
        suppressSessionDetailForKeyRef.current = key;
        void queryClient.cancelQueries({
          queryKey: ["session", key, currentBotId],
        });
        queryClient.removeQueries({
          queryKey: ["session", key, currentBotId],
        });

        const list =
          queryClient.getQueryData<SessionInfo[]>([
            "sessions",
            currentBotId,
          ]) ?? [];
        const remaining = list.filter((row) => row.key !== key);
        const nextKey = pickLatestActiveSessionKey(remaining);

        queryClient.setQueryData<SessionInfo[]>(
          ["sessions", currentBotId],
          remaining,
        );

        flushSync(() => {
          draftSessionActivationRequestedRef.current = false;
          setCurrentSessionKey(null);
          setMessages([]);
          setShowSuggestions(true);
          setSubagentTasks([]);
          if (nextKey) {
            navigate(`/chat/${encodeURIComponent(nextKey)}`, { replace: true });
          } else {
            navigate("/chat", { replace: true });
          }
          setSessionsSidebarOpen(false);
        });
      } else {
        queryClient.setQueryData<SessionInfo[]>(
          ["sessions", currentBotId],
          (old) => (old ? old.filter((row) => row.key !== key) : old),
        );
      }

      return api.deleteSession(key, currentBotId);
    },
    onSuccess: (_, key) => {
      queryClient.invalidateQueries({ queryKey: ["sessions", currentBotId] });
      queryClient.removeQueries({
        queryKey: ["session", key, currentBotId],
      });
      try {
        const stored = localStorage
          .getItem(LAST_CONSOLE_SESSION_STORAGE_KEY)
          ?.trim();
        if (stored === key) {
          localStorage.removeItem(LAST_CONSOLE_SESSION_STORAGE_KEY);
        }
      } catch {
        // ignore
      }
      addToast({ type: "success", message: t("chat.toastSessionDeleted") });
    },
    onError: () => {
      addToast({ type: "error", message: t("chat.toastSessionDeleteFailed") });
    },
  });

  const deleteSessionsBatchMutation = useMutation({
    mutationFn: async (keys: string[]) => {
      const keySet = new Set(keys);
      const current = activeSessionKey?.trim() ?? "";
      const isDeletingCurrent = current.length > 0 && keySet.has(current);

      if (isDeletingCurrent) {
        if (useOpenPawletChannel) {
          disconnectOpenPawletChannelWebSocket();
        }
        suppressSessionDetailForKeyRef.current = current;
        void queryClient.cancelQueries({
          queryKey: ["session", current, currentBotId],
        });
        queryClient.removeQueries({
          queryKey: ["session", current, currentBotId],
        });

        const list =
          queryClient.getQueryData<SessionInfo[]>([
            "sessions",
            currentBotId,
          ]) ?? [];
        const remaining = list.filter((row) => !keySet.has(row.key));
        const nextKey = pickLatestActiveSessionKey(remaining);

        queryClient.setQueryData<SessionInfo[]>(
          ["sessions", currentBotId],
          remaining,
        );

        flushSync(() => {
          draftSessionActivationRequestedRef.current = false;
          setCurrentSessionKey(null);
          setMessages([]);
          setShowSuggestions(true);
          setSubagentTasks([]);
          if (nextKey) {
            navigate(`/chat/${encodeURIComponent(nextKey)}`, { replace: true });
          } else {
            navigate("/chat", { replace: true });
          }
          setSessionsSidebarOpen(false);
        });
      } else {
        queryClient.setQueryData<SessionInfo[]>(
          ["sessions", currentBotId],
          (old) => (old ? old.filter((row) => !keySet.has(row.key)) : old),
        );
      }

      return api.deleteSessionsBatch(keys, currentBotId);
    },
    onSuccess: (data, keys) => {
      queryClient.invalidateQueries({ queryKey: ["sessions", currentBotId] });
      for (const key of keys) {
        queryClient.removeQueries({
          queryKey: ["session", key, currentBotId],
        });
      }
      try {
        for (const key of keys) {
          const stored = localStorage
            .getItem(LAST_CONSOLE_SESSION_STORAGE_KEY)
            ?.trim();
          if (stored === key) {
            localStorage.removeItem(LAST_CONSOLE_SESSION_STORAGE_KEY);
          }
        }
      } catch {
        // ignore
      }
      setBatchSelectedKeys(new Set());
      const failed = data.failed?.length ?? 0;
      const deleted = data.deleted?.length ?? 0;
      if (failed > 0) {
        addToast({
          type: deleted > 0 ? "warning" : "error",
          message: t("chat.toastBatchPartial", { deleted, failed }),
        });
      } else {
        addToast({ type: "success", message: t("chat.toastBatchDeleted", { count: deleted }) });
      }
    },
    onError: () => {
      void queryClient.invalidateQueries({
        queryKey: ["sessions", currentBotId],
      });
      addToast({ type: "error", message: t("chat.toastBatchFailed") });
    },
  });

  const renameSessionMutation = useMutation({
    mutationFn: async (payload: { key: string; title: string }) =>
      api.updateSession(payload.key, { title: payload.title }, currentBotId),
    onSuccess: (updated) => {
      queryClient.setQueryData<SessionInfo[]>(
        ["sessions", currentBotId],
        (old) =>
          old
            ? old.map((row) =>
                row.key === updated.key
                  ? {
                      ...row,
                      title: updated.title,
                      last_message: updated.last_message,
                    }
                  : row,
              )
            : old,
      );
      addToast({ type: "success", message: t("chat.toastSessionRenamed") });
      setRenameSessionModalOpen(false);
      setRenameSessionKey(null);
      setRenameSessionTitle("");
    },
    onError: () => {
      addToast({ type: "error", message: t("chat.toastSessionRenameFailed") });
    },
  });

  /**
   * OpenPawlet 首条消息前勿对草稿 UUID 拉 JSONL（无文件或键与 agent 不一致）。
   * 仅在路由已有 :sessionKey 或不用 OpenPawlet WS 时请求。
   */
  const shouldFetchSessionJsonl =
    Boolean(activeSessionKey) &&
    (!useOpenPawletChannel || paramSessionKey !== undefined);

  const sessionJsonlFetchSuppressedForDeletedRoute =
    suppressSessionDetailForKeyRef.current !== null &&
    suppressSessionDetailForKeyRef.current === activeSessionKey;

  useEffect(() => {
    const suppressed = suppressSessionDetailForKeyRef.current;
    if (!suppressed) {
      return;
    }
    if (paramSessionKey !== suppressed) {
      suppressSessionDetailForKeyRef.current = null;
    }
  }, [paramSessionKey]);

  const { data: sessionData, isError: sessionQueryError, error: sessionQueryErrorObj } =
    useQuery({
      queryKey: ["session", activeSessionKey, currentBotId],
      /**
       * Fetch only the tail page on first load so very long conversations do
       * not bottleneck on a single mega-response; older history is paged in
       * lazily when the user scrolls up (see `loadOlderHistoryPage`).
       */
      queryFn: () =>
        api.getSessionTranscript(activeSessionKey!, currentBotId, {
          limit: CHAT_HISTORY_PAGE_SIZE,
        }),
      enabled: shouldFetchSessionJsonl && !sessionJsonlFetchSuppressedForDeletedRoute,
      retry: false,
    });

  const {
    data: sessionJsonlData,
    isPending: sessionJsonlPending,
    isFetching: sessionJsonlFetching,
    isError: sessionJsonlError,
    error: sessionJsonlErr,
  } = useQuery({
    queryKey: [
      "sessionJsonlRaw",
      activeSessionKey,
      currentBotId,
      sessionJsonlFileSource,
    ],
    queryFn: () =>
      api.getSessionJsonlRaw(
        activeSessionKey!,
        currentBotId,
        sessionJsonlFileSource,
      ),
    enabled: sessionJsonlModalOpen && Boolean(activeSessionKey),
    retry: false,
    // Keep the previously fetched JSONL around between opens so reopening
    // the dialog renders instantly while a background revalidation runs.
    staleTime: 5_000,
    gcTime: 5 * 60_000,
  });

  const sessionJsonlDisplayText = useMemo(() => {
    const raw = sessionJsonlData?.text;
    if (raw == null || raw === "") {
      return "";
    }
    return formatJsonlForDisplay(raw);
  }, [sessionJsonlData?.text]);

  const sessionJsonlCmExtensions = useMemo(
    () => [javascript(), EditorView.lineWrapping],
    [],
  );

  /**
   * Per-turn real assembled LLM context (system prompt + history + user turn).
   * Only fetched while the dialog is open on the assembled-context tab so that
   * large transcripts do not get streamed needlessly while the user sits on
   * the raw JSONL view or the dialog is closed.
   */
  const {
    data: sessionContextData,
    isPending: sessionContextPending,
    isFetching: sessionContextFetching,
    isError: sessionContextError,
    error: sessionContextErr,
  } = useQuery({
    queryKey: ["sessionContext", activeSessionKey, currentBotId],
    queryFn: () =>
      api.getSessionContext(activeSessionKey!, currentBotId),
    // Skip fetching while a turn is still streaming: the context file is
    // rewritten mid-turn and we would otherwise read a half-written record.
    // Once ``isStreaming`` flips back to false the effect below invalidates
    // the query so the freshly-written snapshot is pulled automatically.
    enabled:
      sessionJsonlModalOpen &&
      sessionContextTab === "assembled" &&
      Boolean(activeSessionKey) &&
      !isStreaming,
    retry: false,
    // Preserve the previous snapshot so reopening the dialog or switching
    // back to the assembled tab shows the last context immediately while
    // a background refresh runs.  ``invalidateQueries`` calls below still
    // trigger an authoritative refetch when the modal opens.
    staleTime: 5_000,
    gcTime: 5 * 60_000,
  });

  const sessionContextLatest = sessionContextData?.latest ?? null;
  const sessionContextLatestText = sessionContextLatest?.context_text ?? "";
  const sessionContextHasRecord = Boolean(sessionContextLatest);
  const sessionContextTurnIndex = sessionContextLatest?.turn_index ?? null;
  const sessionContextTimestamp = sessionContextLatest?.timestamp ?? null;

  /**
   * Refresh the assembled-context snapshot whenever the user either opens the
   * dialog or switches back to the assembled tab.  The backend overwrites the
   * ``context/{key}.jsonl`` file on every turn, so the cached query result is
   * stale once a new turn completes — invalidating forces a fresh fetch.
   */
  useEffect(() => {
    if (!sessionJsonlModalOpen) {
      return;
    }
    if (sessionContextTab !== "assembled") {
      return;
    }
    if (!activeSessionKey) {
      return;
    }
    void queryClient.invalidateQueries({
      queryKey: ["sessionContext", activeSessionKey, currentBotId],
    });
  }, [
    sessionJsonlModalOpen,
    sessionContextTab,
    activeSessionKey,
    currentBotId,
    queryClient,
  ]);

  /**
   * When a turn finishes streaming, the assembled context on disk has just
   * been rewritten.  If the dialog is still open on the assembled tab, pull
   * the new snapshot so the user does not have to close and reopen.
   */
  const prevIsStreamingRef = useRef<boolean>(false);
  useEffect(() => {
    const wasStreaming = prevIsStreamingRef.current;
    prevIsStreamingRef.current = isStreaming;
    if (!wasStreaming || isStreaming) {
      return;
    }
    if (!sessionJsonlModalOpen || sessionContextTab !== "assembled") {
      return;
    }
    if (!activeSessionKey) {
      return;
    }
    void queryClient.invalidateQueries({
      queryKey: ["sessionContext", activeSessionKey, currentBotId],
    });
  }, [
    isStreaming,
    sessionJsonlModalOpen,
    sessionContextTab,
    activeSessionKey,
    currentBotId,
    queryClient,
  ]);

  /**
   * 路由里带了 :sessionKey 但磁盘上已无该会话（例如旧 bookmark）时，改为打开列表中最新创建的会话。
   */
  useEffect(() => {
    if (!sessionQueryError || !paramSessionKey) {
      return;
    }
    if (paramSessionKey !== activeSessionKey) {
      return;
    }
    if (!isSessionMissingError(sessionQueryErrorObj)) {
      return;
    }
    if (sessionsListPending) {
      return;
    }

    const list = sessions ?? [];
    if (list.length === 0) {
      draftSessionActivationRequestedRef.current = false;
      setCurrentSessionKey(null);
      navigate("/chat", { replace: true });
      return;
    }

    const newestKey = pickLatestActiveSessionKey(list);
    if (!newestKey) {
      return;
    }
    if (newestKey === paramSessionKey) {
      draftSessionActivationRequestedRef.current = false;
      setCurrentSessionKey(null);
      navigate("/chat", { replace: true });
      return;
    }

    setCurrentSessionKey(newestKey);
    navigate(`/chat/${encodeURIComponent(newestKey)}`, { replace: true });
  }, [
    sessionQueryError,
    sessionQueryErrorObj,
    paramSessionKey,
    activeSessionKey,
    sessionsListPending,
    sessions,
    navigate,
    setCurrentSessionKey,
  ]);

  // 仅路由 param 变化时清空（侧栏切换、回 /chat）；勿用 activeSessionKey，否则 stream 里
  // session_key 更新 URL 会误清空当前消息。
  const prevParamSessionKeyForMessagesRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const prev = prevParamSessionKeyForMessagesRef.current;
    if (prev !== undefined && prev !== paramSessionKey) {
      setMessages([]);
    }
    // Bare `/chat`: always show the welcome hero. Do not tie this to `activeSessionKey`:
    // OpenPawlet promotes `/chat` → `/chat/:id` before the first message, but the session
    // is still empty and should keep the hero until the user sends or history loads.
    if (paramSessionKey === undefined) {
      setShowSuggestions(true);
    }
    prevParamSessionKeyForMessagesRef.current = paramSessionKey;
  }, [paramSessionKey]);

  /**
   * Build a stable id for a transcript row.
   *
   * Previously ids were `msg-{idx}-{Date.now()}`, which meant every replay of
   * the sync effect produced new keys; that broke the virtualized list's
   * height cache and forced React to reconcile every historical row even when
   * no data changed. Keying by absolute transcript offset + role + timestamp
   * keeps ids stable across refetches while still differentiating adjacent
   * rows that share an offset slot (e.g. tool replies that reuse a ts).
   */
  const buildStableMessageId = useCallback(
    (msg: Message, absoluteIndex: number): string => {
      const ts = msg.timestamp ?? msg.created_at ?? "";
      const role = msg.role ?? "x";
      const toolCallId = msg.tool_call_id ?? "";
      return `m:${absoluteIndex}:${role}:${toolCallId}:${ts}`;
    },
    [],
  );

  const {
    setHistoryOldestOffset,
    historyHasMore,
    setHistoryHasMore,
    loadingOlder,
    loadingOlderRef,
    loadOlderHistoryPage,
  } = useChatHistoryPaging({
    activeSessionKey,
    currentBotId,
    buildStableMessageId,
    setMessages,
    addToast,
    t,
  });

  useEffect(() => {
    if (!sessionData?.messages) {
      if (!activeSessionKey) {
        setShowSuggestions(true);
      }
      return;
    }

    const serverMessages = sessionData.messages as Message[];
    // Pagination metadata drives the "load older" control. `offset` is absent
    // in the legacy full-history shape; fall back to 0 so prev-page fetches
    // are disabled (nothing to page before an un-paged response).
    const nextOldestOffset =
      typeof sessionData.offset === "number" ? sessionData.offset : 0;
    const nextHasMore = Boolean(sessionData.has_more);

    if (!isStreaming) {
      setMessages((prev) => {
        // If local state already has more messages than the server tail page
        // (e.g. we just appended an assistant bubble on chat_done), don't
        // overwrite with the older paged snapshot.
        if (prev.length > serverMessages.length) return prev;
        return serverMessages.map((msg, idx) => ({
          ...msg,
          id: buildStableMessageId(msg, nextOldestOffset + idx),
        }));
      });
      setHistoryOldestOffset(nextOldestOffset);
      setHistoryHasMore(nextHasMore);
      setShowSuggestions(serverMessages.length === 0);
      return;
    }

    // Stream just started and session/transcript fetch returned messages
    // (user turn already persisted on the server). Load them so the user
    // message appears immediately.
    setMessages((prev) => {
      if (prev.length > 0) return prev;
      return serverMessages.map((msg, idx) => ({
        ...msg,
        id: buildStableMessageId(msg, nextOldestOffset + idx),
      }));
    });
    setHistoryOldestOffset(nextOldestOffset);
    setHistoryHasMore(nextHasMore);
  }, [
    sessionData,
    activeSessionKey,
    isStreaming,
    buildStableMessageId,
    setHistoryHasMore,
    setHistoryOldestOffset,
  ]);

  // Keep sidebar message_count in sync with GET /sessions/:key/transcript without refetching the full list.
  const sessionMessageCount = sessionData?.message_count;
  useEffect(() => {
    if (!activeSessionKey || sessionMessageCount === undefined) {
      return;
    }
    queryClient.setQueryData<SessionInfo[]>(
      ["sessions", currentBotId],
      (old) => {
        if (!old) {
          return old;
        }
        let changed = false;
        const next = old.map((row) => {
          if (row.key !== activeSessionKey) {
            return row;
          }
          if (row.message_count === sessionMessageCount) {
            return row;
          }
          changed = true;
          return { ...row, message_count: sessionMessageCount };
        });
        return changed ? next : old;
      },
    );
  }, [activeSessionKey, sessionMessageCount, currentBotId, queryClient]);

  /**
   * 先把 `role: tool` 的 content 合并进对应 `tool_call_id` 的 assistant
   * tool_calls，再按 source 过滤子 Agent / tool_call 行。
   */
  const displayMessages = useMemo(() => {
    const merged = mergeToolResultsIntoAssistantMessages(messages);
    const normalized = merged.map((m) => normalizeMessageForChatRender(m));
    const visible = normalized.filter(
      (m) => m.source !== "sub_agent" && m.source !== "tool_call",
    );
    return groupAssistantReplies(visible);
  }, [messages]);

  /**
   * Identify the latest assistant bubble that still has an unanswered
   * ``ask_user`` tool call. Only this row gets the interactive prompt UI;
   * older pending entries (rare, but possible if the transcript is
   * corrupted) stay read-only so the user cannot accidentally answer a
   * historical question.
   */
  const latestPendingAskUserMsgId = useMemo<string | null>(() => {
    for (let i = displayMessages.length - 1; i >= 0; i -= 1) {
      const msg = displayMessages[i];
      if (msg.role !== "assistant" || !msg.tool_calls?.length) {
        continue;
      }
      const hasPendingAsk = msg.tool_calls.some(
        (tc) => tc.name === "ask_user" && tc.result === undefined,
      );
      if (hasPendingAsk) {
        return msg.id;
      }
    }
    return null;
  }, [displayMessages]);

  /**
   * Poll the virtual list scroll offset on every scroll event:
   * - keeps `messagesStickToBottomRef` accurate so new tokens only auto-scroll
   *   when the user is actively reading the tail;
   * - drives the "jump to latest" pill;
   * - triggers prev-page lazy loads when the viewport nears the top.
   */
  const handleVirtualScroll = useCallback(() => {
    const handle = virtualListHandleRef.current;
    if (!handle) return;
    const distBottom = handle.distanceFromBottom();
    const nearBottom = distBottom <= CHAT_NEAR_BOTTOM_PX;
    messagesStickToBottomRef.current = nearBottom;
    setShowJumpToBottom(!nearBottom);
    if (nearBottom) {
      setUnreadBelowCount(0);
    }

    const scroller = document.querySelector<HTMLDivElement>(
      '[data-testid="chat-virtual-scroll"]',
    );
    if (
      scroller &&
      scroller.scrollTop <= CHAT_HISTORY_TOP_TRIGGER_PX &&
      historyHasMore &&
      !loadingOlderRef.current
    ) {
      void loadOlderHistoryPage();
    }
  }, [
    virtualListHandleRef,
    historyHasMore,
    loadOlderHistoryPage,
    loadingOlderRef,
  ]);

  // Attach scroll listener to the virtualization scroll parent.
  useEffect(() => {
    const attach = () => {
      const scroller = document.querySelector<HTMLDivElement>(
        '[data-testid="chat-virtual-scroll"]',
      );
      if (!scroller) return null;
      scroller.addEventListener("scroll", handleVirtualScroll, { passive: true });
      return scroller;
    };
    // React commits before we can find the node; wait one frame.
    let scrollerEl: HTMLDivElement | null = null;
    const raf = requestAnimationFrame(() => {
      scrollerEl = attach();
    });
    return () => {
      cancelAnimationFrame(raf);
      if (scrollerEl) {
        scrollerEl.removeEventListener("scroll", handleVirtualScroll);
      }
    };
  }, [handleVirtualScroll, activeSessionKey]);

  /**
   * Auto-follow only when the user is near the bottom. We additionally count
   * unread assistant bubbles while the user is reading older history so the
   * "jump to latest" pill can surface a helpful hint.
   */
  useEffect(() => {
    const handle = virtualListHandleRef.current;
    if (!handle) return;
    if (displayMessages.length <= 1 && !isStreaming) {
      handle.scrollToBottom(false);
      messagesStickToBottomRef.current = true;
      setShowJumpToBottom(false);
      setUnreadBelowCount(0);
      return;
    }
    if (messagesStickToBottomRef.current) {
      handle.scrollToBottom(false);
    } else {
      // User scrolled up; bump the unread counter whenever a new message is
      // appended (either assistant finalization or streaming start).
      setUnreadBelowCount((n) => n + 1);
    }
  }, [
    virtualListHandleRef,
    displayMessages.length,
    isStreaming,
  ]);

  /**
   * During streaming we only want to follow the tail; we intentionally do
   * NOT bump the unread counter on every token, and we skip the scroll when
   * the user is away from the bottom. Split out from the length effect so
   * the high-frequency `streamingContent` / tool progress updates don't
   * trigger the length-based "unread" bump.
   */
  useEffect(() => {
    const handle = virtualListHandleRef.current;
    if (!handle) return;
    if (!messagesStickToBottomRef.current) return;
    handle.scrollToBottom(false);
  }, [
    virtualListHandleRef,
    streamingContent,
    streamingToolProgress.length,
    streamingChannelNotices.length,
    streamingPayloadToolCalls.length,
    streamingReasoningContent,
    isStreaming,
  ]);

  const jumpToBottom = useCallback(() => {
    const handle = virtualListHandleRef.current;
    if (!handle) return;
    messagesStickToBottomRef.current = true;
    setUnreadBelowCount(0);
    setShowJumpToBottom(false);
    handle.scrollToBottom(true);
  }, [virtualListHandleRef]);

  const handleStreamChunk = useCallback(
    (chunk: StreamChunk, source: ChatChunkSource) => {
      // When both transports are configured, bind this page to a single
      // source to prevent duplicate tokens / `chat_done` events from
      // console `/ws` and OpenPawlet `/openpawlet-ws` being merged into one stream.
      if (useOpenPawletChannel) {
        if (source !== "openpawlet") {
          return;
        }
      } else if (source !== "console") {
        return;
      }
      // Lock the streaming bubble's reply_group_id to the first server-issued
      // value observed in this turn. The runtime stamps the same UUID onto
      // every frame, so we don't need to update it on later frames.
      if (
        chunk.reply_group_id &&
        typeof chunk.reply_group_id === "string" &&
        !streamingReplyGroupIdRef.current
      ) {
        streamingReplyGroupIdRef.current = chunk.reply_group_id;
      }
      if (silentStatusJsonRef.current) {
        if (chunk.type === "session_key") {
          return;
        }
        if (chunk.type === "chat_start") {
          return;
        }
        if (chunk.type === "status") {
          completeSilentStatusJsonPoll("", {
            fromEarlyParse: true,
            parsedUsage: parseOpenPawletStatusFromChunk(chunk),
          });
          return;
        }
        if (chunk.type === "chat_token" || chunk.type === "channel_notice") {
          return;
        }
        if (chunk.type === "stream_end") {
          return;
        }
        if (chunk.type === "chat_done") {
          completeSilentStatusJsonPoll(streamChunkText(chunk));
          return;
        }
        if (chunk.type === "error" && chunk.error) {
          completeSilentStatusJsonPoll("");
          return;
        }
        return;
      }
      if (chunk.type === "status") {
        const parsed = parseOpenPawletStatusFromChunk(chunk);
        if (parsed) {
          setOpenPawletContextUsage(parsed);
        }
        return;
      }
      if (chunk.type === "session_key" && chunk.session_key) {
        const nextKey = chunk.session_key.trim();
        if (!nextKey) {
          return;
        }
        const shouldAdoptServerSessionKey =
          !activeSessionKey ||
          draftSessionActivationRequestedRef.current ||
          readOpenPawletChatNewIntent();
        if (!shouldAdoptServerSessionKey && nextKey !== activeSessionKey) {
          // Keep current thread stable during normal chatting; only draft/new
          // flows can adopt a new server session key.
          return;
        }
        draftSessionActivationRequestedRef.current = false;
        setCurrentSessionKey(nextKey);
        navigate(`/chat/${encodeURIComponent(nextKey)}`, {
          replace: true,
        });
        queryClient.invalidateQueries({ queryKey: ["sessions"] });
      } else if (chunk.type === "chat_start") {
        streamingPrimedByServerRef.current = false;
        setIsStreaming(true);
      } else if (chunk.type === "channel_notice" && chunk.content) {
        const noticeText = chunk.content as string;
        const usageFromStatus = parseOpenPawletStatusPlainText(noticeText);
        if (usageFromStatus) {
          setOpenPawletContextUsage(usageFromStatus);
        }
        // After the assistant turn already finalized (e.g. after `/stop`
        // emitted `chat_end`, the trailing `Stopped N task(s).` confirmation
        // arrives as a `message` frame) treat the notice as a standalone
        // system bubble in the message list instead of a transient streaming
        // notice that would otherwise re-enter streaming UI and stay there
        // forever (no further `chat_end` follows).
        if (
          assistantReplyFinalizedRef.current ||
          !isStreamingRef.current
        ) {
          const systemMsg: Message = {
            id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            role: "system",
            content: noticeText,
            created_at: new Date().toISOString(),
            source: "main_agent",
            ...(chunk.reply_group_id
              ? { reply_group_id: chunk.reply_group_id }
              : {}),
          };
          setMessages((prev) => [...prev, systemMsg]);
          if (useOpenPawletChannel) {
            scheduleOpenPawletStatusJson();
          }
          return;
        }
        streamingPrimedByServerRef.current = false;
        setIsStreaming(true);
        setStreamingChannelNotices((prev) => [...prev, noticeText]);
        if (
          typeof chunk.reasoning_content === "string" &&
          chunk.reasoning_content.length > 0
        ) {
          streamingReasoningContentRef.current = chunk.reasoning_content;
          setStreamingReasoningContent(chunk.reasoning_content);
        }
      } else if (chunk.type === "chat_token") {
        const hasText =
          typeof chunk.content === "string" && chunk.content.length > 0;
        const hasEmbeddedTools = chunk.tool_calls !== undefined;
        const hasReasoning = chunk.reasoning_content !== undefined;
        if (!hasText && !hasEmbeddedTools && !hasReasoning) {
          return;
        }
        if (hasText && chunk.content) {
          streamingContentRef.current += chunk.content;
          pendingStreamTokenDeltaRef.current += chunk.content;
          if (streamTokenFlushRafRef.current === null) {
            streamTokenFlushRafRef.current = requestAnimationFrame(() => {
              streamTokenFlushRafRef.current = null;
              const delta = pendingStreamTokenDeltaRef.current;
              pendingStreamTokenDeltaRef.current = "";
              if (delta) {
                setStreamingContent((prev) => prev + delta);
              }
            });
          }
        }
        if (hasEmbeddedTools) {
          const incoming = chunk.tool_calls ?? [];
          scheduleTranscriptSync();
          if (isStreamingRef.current) {
            const merged = mergeStreamingToolCalls(
              streamingPayloadToolCallsRef.current,
              incoming,
            );
            streamingPayloadToolCallsRef.current = merged;
            setStreamingPayloadToolCalls(merged);
          } else {
            /* OpenPawlet may send tool_event after chat_end; merge into last assistant bubble. */
            streamingPayloadToolCallsRef.current = [];
            setStreamingPayloadToolCalls([]);
            setMessages((prev) => {
              if (prev.length === 0) {
                return prev;
              }
              const lastIdx = prev.length - 1;
              const last = prev[lastIdx];
              if (last.role !== "assistant") {
                return prev;
              }
              const mergedCalls = mergeStreamingToolCalls(
                last.tool_calls ?? [],
                incoming,
              );
              const next = [...prev];
              next[lastIdx] = { ...last, tool_calls: mergedCalls };
              return next;
            });
            queryClient.setQueryData(
              ["session", activeSessionKey, currentBotId],
              (old: typeof sessionData | undefined) => {
                if (!old?.messages?.length) {
                  return old;
                }
                const msgs = [...(old.messages ?? [])];
                const li = msgs.length - 1;
                const last = msgs[li] as Message | undefined;
                if (!last || last.role !== "assistant") {
                  return old;
                }
                const mergedCalls = mergeStreamingToolCalls(
                  last.tool_calls ?? [],
                  incoming,
                );
                msgs[li] = { ...last, tool_calls: mergedCalls };
                return { ...old, messages: msgs };
              },
            );
          }
        }
        if (hasReasoning) {
          const r = chunk.reasoning_content ?? "";
          if (chunk.reasoning_append) {
            const merged = streamingReasoningContentRef.current + r;
            streamingReasoningContentRef.current = merged;
            setStreamingReasoningContent(merged);
          } else {
            streamingReasoningContentRef.current = r;
            setStreamingReasoningContent(r);
          }
        }
      } else if (chunk.type === "stream_end") {
        cancelStreamTokenFlush();
        if (chunk.tool_calls?.length) {
          const incoming = chunk.tool_calls;
          const merged = mergeStreamingToolCalls(
            streamingPayloadToolCallsRef.current,
            incoming,
          );
          streamingPayloadToolCallsRef.current = merged;
          setStreamingPayloadToolCalls(merged);
          scheduleTranscriptSync();
        }
        if (chunk.reasoning_content !== undefined) {
          streamingReasoningContentRef.current = chunk.reasoning_content;
          setStreamingReasoningContent(chunk.reasoning_content);
        }
      } else if (chunk.type === "tool_progress" && chunk.content) {
        setStreamingToolProgress((prev) => [...prev, chunk.content as string]);
      } else if (chunk.type === "tool_call" && chunk.tool_call) {
        const tc = chunk.tool_call;
        setToolCalls((prev) => [
          ...prev,
          {
            id: tc.id,
            name: tc.name,
            args: JSON.stringify(tc.arguments, null, 2),
            status: "running",
          },
        ]);
      } else if (chunk.type === "tool_result" && chunk.tool_name) {
        setToolCalls((prev) =>
          prev.map((tc) =>
            tc.name === chunk.tool_name
              ? { ...tc, status: "success", result: chunk.tool_result }
              : tc,
          ),
        );
      } else if (chunk.type === "error" && chunk.error) {
        setStreamingChannelNotices([]);
        setStreamingToolProgress([]);
        setToolCalls((prev) =>
          prev.map((tc) => ({ ...tc, status: "error", result: chunk.error })),
        );
        addToast({ type: "error", message: chunk.error });
      } else if (
        chunk.type === "subagent_start" &&
        chunk.subagent_id &&
        chunk.label
      ) {
        // Subagent started - add to panel
        const subagentId = chunk.subagent_id;
        const subagentLabel = chunk.label;
        setSubagentTasks((prev) => [
          ...prev,
          {
            id: subagentId,
            label: subagentLabel,
            task: chunk.task,
            status: "running",
          },
        ]);
        setSubagentPanelOpen(true);
      } else if (chunk.type === "assistant_message" && chunk.content) {
        const assistantContent = chunk.content;
        setMessages((prev) => [
          ...prev,
          {
            id: `msg-${Date.now()}-${Math.random()}`,
            role: "assistant",
            content: assistantContent,
            created_at: new Date().toISOString(),
            source: chunk.source ?? "main_agent",
            ...(chunk.tool_calls?.length ? { tool_calls: chunk.tool_calls } : {}),
            ...(chunk.reasoning_content
              ? { reasoning_content: chunk.reasoning_content }
              : {}),
            ...(chunk.reply_group_id
              ? { reply_group_id: chunk.reply_group_id }
              : {}),
          },
        ]);
      } else if (chunk.type === "subagent_done" && chunk.subagent_id) {
        // Subagent completed - update status
        setSubagentTasks((prev) =>
          prev.map((task) =>
            task.id === chunk.subagent_id
              ? {
                  ...task,
                  status: chunk.status === "ok" ? "success" : "error",
                  result: chunk.result,
                }
              : task,
          ),
        );
      } else if (chunk.type === "chat_done") {
        if (expectStatusJsonTrailingChatDoneRef.current) {
          const streamedText = streamingContentRef.current;
          const fromChunk = resolveChatDonePrimaryText(chunk);
          const hasReal =
            fromChunk.trim().length > 0 ||
            streamedText.trim().length > 0 ||
            (chunk.tool_calls?.length ?? 0) > 0 ||
            streamingPayloadToolCallsRef.current.length > 0 ||
            streamingReasoningContentRef.current.length > 0;
          expectStatusJsonTrailingChatDoneRef.current = false;
          if (!hasReal) {
            // Even when this trailing frame carries no renderable content, it
            // still terminates the turn — clear the streaming UI so the input
            // box flips back to "send" mode (#stop button bug).
            cancelStreamTokenFlush();
            setIsStreaming(false);
            setStreamingContent("");
            streamingContentRef.current = "";
            setStreamingToolProgress([]);
            setStreamingChannelNotices([]);
            setStreamingPayloadToolCalls([]);
            setStreamingReasoningContent("");
            streamingPayloadToolCallsRef.current = [];
            streamingReasoningContentRef.current = "";
            return;
          }
        }
        if (assistantReplyFinalizedRef.current) {
          // A second `chat_end` for the same reply group: still drive the UI
          // back to idle so the stop button reliably ends streaming even if
          // an earlier finalize path forgot to flip the flag.
          cancelStreamTokenFlush();
          setIsStreaming(false);
          setStreamingContent("");
          streamingContentRef.current = "";
          setStreamingToolProgress([]);
          setStreamingChannelNotices([]);
          setStreamingPayloadToolCalls([]);
          setStreamingReasoningContent("");
          streamingPayloadToolCallsRef.current = [];
          streamingReasoningContentRef.current = "";
          return;
        }
        assistantReplyFinalizedRef.current = true;
        cancelStreamTokenFlush();
        const refTools = streamingPayloadToolCallsRef.current;
        const refReason = streamingReasoningContentRef.current;
        const chunkTools = chunk.tool_calls ?? [];
        const mergedToolCalls =
          chunkTools.length > 0 || refTools.length > 0
            ? mergeStreamingToolCalls(refTools, chunkTools)
            : undefined;
        const mergedReasoning =
          chunk.reasoning_content !== undefined
            ? chunk.reasoning_content
            : refReason || undefined;
        const streamedText = streamingContentRef.current;
        const primary = resolveChatDonePrimaryText(chunk);
        const fromChunk = primary !== "" ? primary : streamedText;
        streamingContentRef.current = "";
        streamingPayloadToolCallsRef.current = [];
        streamingReasoningContentRef.current = "";
        setStreamingPayloadToolCalls([]);
        setStreamingReasoningContent("");
        setIsStreaming(false);
        setStreamingContent("");
        setStreamingToolProgress([]);
        setStreamingChannelNotices([]);
        // Any throttled mid-turn transcript refresh is superseded by chat_done.
        cancelTranscriptSync();
        // When the turn ends with no actual content (e.g. the user pressed
        // "Stop" and OpenPawlet's `_dispatch` finally emits a bare `chat_end`
        // lifecycle frame after task cancellation), skip appending an empty
        // assistant bubble. The follow-up confirmation `message` frame
        // ("Stopped N task(s).") still arrives and is rendered through the
        // ``channel_notice`` branch below.
        const hasRenderableContent =
          fromChunk.length > 0 ||
          (mergedToolCalls && mergedToolCalls.length > 0) ||
          (mergedReasoning !== undefined && mergedReasoning.length > 0);
        if (!hasRenderableContent) {
          streamingReplyGroupIdRef.current = null;
          setToolCalls([]);
          if (useOpenPawletChannel) {
            scheduleOpenPawletStatusJson();
          }
          return;
        }
        const assistantMsg: Message = {
          id: `msg-${Date.now()}`,
          role: "assistant",
          content: fromChunk,
          created_at: new Date().toISOString(),
          source: chunk.source ?? "main_agent",
          ...(mergedToolCalls && mergedToolCalls.length > 0
            ? { tool_calls: mergedToolCalls }
            : {}),
          ...(mergedReasoning !== undefined && mergedReasoning.length > 0
            ? { reasoning_content: mergedReasoning }
            : {}),
          ...(chunk.reply_group_id
            ? { reply_group_id: chunk.reply_group_id }
            : streamingReplyGroupIdRef.current
              ? { reply_group_id: streamingReplyGroupIdRef.current }
              : {}),
        };
        streamingReplyGroupIdRef.current = null;
        setMessages((prev) => [...prev, assistantMsg]);
        setToolCalls([]);
        // Avoid invalidating ["sessions"]; that refetches the full sidebar list each
        // `chat_done` / `chat_end` and feels like a page refresh. Count sync is handled
        // by session cache + setQueryData below and the `sessionMessageCount` effect.
        // Update the session cache so sessionData stays in sync with the latest session.
        // Functional form reads current cache at call time, avoiding stale closure values.
        queryClient.setQueryData(
          ["session", activeSessionKey, currentBotId],
          (old: typeof sessionData | undefined) => {
            if (!old) return old;
            return {
              ...old,
              messages: [...(old.messages ?? []), assistantMsg],
              message_count: (old.message_count ?? 0) + 1,
            };
          },
        );
        if (useOpenPawletChannel) {
          scheduleOpenPawletStatusJson();
        }
      }
    },
    [
      addToast,
      queryClient,
      navigate,
      setCurrentSessionKey,
      activeSessionKey,
      currentBotId,
      cancelStreamTokenFlush,
      completeSilentStatusJsonPoll,
      scheduleOpenPawletStatusJson,
      scheduleTranscriptSync,
      cancelTranscriptSync,
      useOpenPawletChannel,
      expectStatusJsonTrailingChatDoneRef,
      setOpenPawletContextUsage,
      silentStatusJsonRef,
    ],
  );

  // Register WebSocket chat message handler (WS streaming replaces SSE)
  useEffect(() => {
    const unregister = registerChatHandler(handleStreamChunk);
    return unregister;
  }, [handleStreamChunk]);

  // Clean up any pending transcript refetch timer on unmount / session change.
  useEffect(() => {
    return () => cancelTranscriptSync();
  }, [cancelTranscriptSync]);

  // OpenPawlet `ws` 频道：连接就绪后发送队列中的首条消息（新会话）
  useEffect(() => {
    if (!useOpenPawletChannel || !openpawletWsReady) {
      return;
    }
    const pending = pendingOpenPawletOutboundRef.current;
    if (!pending) {
      return;
    }
    try {
      sendOpenPawletMessage({
        content: pending,
        botId: currentBotId,
      });
      pendingOpenPawletOutboundRef.current = null;
    } catch {
      pendingOpenPawletOutboundRef.current = null;
      cancelStreamTokenFlush();
      setIsStreaming(false);
      setStreamingContent("");
      streamingContentRef.current = "";
      addToast({
        type: "error",
        message: t("chat.toastWsSendFailed"),
      });
    }
  }, [
    useOpenPawletChannel,
    openpawletWsReady,
    currentBotId,
    sendOpenPawletMessage,
    addToast,
    cancelStreamTokenFlush,
    t,
  ]);

  const handleSend = async (overrideMessage?: string) => {
    // ``overrideMessage`` lets callers (e.g. the AskUser interactive prompt
    // in the message list) submit text without first stuffing it into the
    // textarea — the input box stays untouched and the message goes
    // through the same WS path as a normal Enter-to-send.
    //
    // Guard with `typeof === "string"` because the send button's
    // ``onClick={onSend}`` forwards a SyntheticMouseEvent into the first
    // argument; treating any truthy value as an override would both wreck
    // the message body AND skip the textarea reset.
    const hasOverride = typeof overrideMessage === "string";
    const candidate = hasOverride ? overrideMessage : input;
    if (!candidate.trim() || isStreaming) return;

    const userMessage = candidate.trim();
    if (!hasOverride) {
      setInput("");
    }
    setShowSuggestions(false);
    messagesStickToBottomRef.current = true;

    setMessages((prev) => [
      ...prev,
      {
        id: `user-${Date.now()}`,
        role: "user",
        content: userMessage,
        created_at: new Date().toISOString(),
        source: "user",
      },
    ]);

    cancelStreamTokenFlush();
    assistantReplyFinalizedRef.current = false;
    setIsStreaming(true);
    setStreamingContent("");
    streamingContentRef.current = "";
    setToolCalls([]);
    setStreamingToolProgress([]);
    setStreamingChannelNotices([]);
    setStreamingPayloadToolCalls([]);
    setStreamingReasoningContent("");
    streamingPayloadToolCallsRef.current = [];
    streamingReasoningContentRef.current = "";
    streamingReplyGroupIdRef.current = null;

    if (useOpenPawletChannel) {
      if (!activeSessionKey) {
        // Bare `/chat` stays as draft until first message is sent. Once outbound
        // starts, mark activation and materialize the server session on `ready`.
        draftSessionActivationRequestedRef.current = true;
        setDraftSessionActivationTick((n) => n + 1);
        // Opt-in flag to let `openpawletChannelWsEnabled` open the socket on the
        // bare `/chat` route. Without this, an empty sessions list keeps the
        // WS closed (avoiding the empty-session ghost on backend restart) and
        // pending messages would never reach the server.
        try {
          sessionStorage.setItem(OPENPAWLET_CHAT_NEW_INTENT_STORAGE_KEY, "1");
        } catch {
          // ignore quota / private mode
        }
        pendingOpenPawletOutboundRef.current = userMessage;
        if (openpawletWsReady) {
          try {
            sendOpenPawletMessage({
              content: userMessage,
              botId: currentBotId,
            });
            pendingOpenPawletOutboundRef.current = null;
          } catch {
            cancelStreamTokenFlush();
            setIsStreaming(false);
            setStreamingContent("");
            streamingContentRef.current = "";
            pendingOpenPawletOutboundRef.current = null;
            addToast({
              type: "error",
              message: t("chat.toastWsSendFailed"),
            });
          }
        }
        return;
      }
      if (!openpawletWsReady) {
        pendingOpenPawletOutboundRef.current = userMessage;
        return;
      }
      try {
        sendOpenPawletMessage({
          content: userMessage,
          botId: currentBotId,
        });
      } catch {
        cancelStreamTokenFlush();
        setIsStreaming(false);
        setStreamingContent("");
        streamingContentRef.current = "";
        addToast({
          type: "error",
          message: t("chat.toastWsNotReady"),
        });
      }
      return;
    }

    const ws = getWSRef()?.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      cancelStreamTokenFlush();
      setIsStreaming(false);
      setStreamingContent("");
      streamingContentRef.current = "";
      addToast({ type: "error", message: t("chat.toastWsNotConnected") });
      return;
    }

    ws.send(JSON.stringify({
      type: "chat",
      message: userMessage,
      session_key: activeSessionKey || undefined,
      bot_id: currentBotId || undefined,
    }));
  };

  const handleStop = () => {
    // Send `/stop` slash command to the active WebSocket so OpenPawlet's
    // command router cancels in-flight tasks for this session. The
    // server emits ``chat_end`` (lifecycle finally) followed by a
    // confirmation ``message`` frame ("Stopped N task(s).").
    let dispatched = false;

    if (useOpenPawletChannel) {
      if (openpawletWsReady) {
        try {
          sendOpenPawletMessage({ content: "/stop", botId: currentBotId });
          dispatched = true;
        } catch (e) {
          console.warn("[chat] failed to send /stop via openpawlet ws", e);
        }
      }
    } else {
      const ws = getWSRef()?.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(
            JSON.stringify({
              type: "chat",
              message: "/stop",
              session_key: activeSessionKey || undefined,
              bot_id: currentBotId || undefined,
            }),
          );
          dispatched = true;
        } catch (e) {
          console.warn("[chat] failed to send /stop via console ws", e);
        }
      }
    }

    // Drive the streaming UI to "stopped" immediately so users get instant
    // feedback regardless of how fast the server's ``chat_end`` arrives or
    // whether an earlier ``message`` frame ("Stopped N task(s).") races
    // ahead of the lifecycle terminator. ``assistantReplyFinalizedRef`` is
    // flipped so the trailing `message` frame is rendered as a standalone
    // system bubble (see ``channel_notice`` branch) instead of re-entering
    // streaming mode and stranding the input bar in stop-button state.
    cancelStreamTokenFlush();
    cancelTranscriptSync();
    // If the cancelled turn already produced visible content, persist it as
    // an interrupted assistant bubble so users keep the partial reply.
    const partialText = streamingContentRef.current;
    const partialTools = streamingPayloadToolCallsRef.current;
    const partialReasoning = streamingReasoningContentRef.current;
    const hasPartialContent =
      partialText.length > 0 ||
      partialTools.length > 0 ||
      partialReasoning.length > 0;
    if (hasPartialContent) {
      const interruptedMsg: Message = {
        id: `msg-${Date.now()}`,
        role: "assistant",
        content: partialText,
        created_at: new Date().toISOString(),
        source: "main_agent",
        ...(partialTools.length > 0 ? { tool_calls: partialTools } : {}),
        ...(partialReasoning.length > 0
          ? { reasoning_content: partialReasoning }
          : {}),
        ...(streamingReplyGroupIdRef.current
          ? { reply_group_id: streamingReplyGroupIdRef.current }
          : {}),
      };
      setMessages((prev) => [...prev, interruptedMsg]);
    }
    assistantReplyFinalizedRef.current = true;
    setIsStreaming(false);
    setStreamingContent("");
    streamingContentRef.current = "";
    setToolCalls([]);
    setStreamingToolProgress([]);
    setStreamingChannelNotices([]);
    setStreamingPayloadToolCalls([]);
    setStreamingReasoningContent("");
    streamingPayloadToolCallsRef.current = [];
    streamingReasoningContentRef.current = "";
    streamingReplyGroupIdRef.current = null;

    if (dispatched) {
      addToast({ type: "info", message: t("chat.toastStopped") });
    } else {
      addToast({ type: "error", message: t("chat.toastWsNotConnected") });
    }
  };

  /**
   * Submit a user reply to a pending ``ask_user`` agent prompt rendered
   * inline in the message list. Pushes the chosen text through the same
   * WS path as a normal message; OpenPawlet routes it back as the matching
   * tool result (``pending_ask_user_id`` in ``agent/loop.py``).
   */
  const handleAskUserAnswer = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isStreaming) {
        return;
      }
      void handleSend(trimmed);
    },
    // ``handleSend`` is recreated each render but only reads stable refs
    // beyond the streaming flag we already gate on, so omit it from deps
    // intentionally. Adding it would defeat the useCallback purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isStreaming],
  );

  const handleNewChat = () => {
    draftSessionActivationRequestedRef.current = false;
    try {
      localStorage.removeItem(LAST_CONSOLE_SESSION_STORAGE_KEY);
      sessionStorage.setItem(OPENPAWLET_CHAT_NEW_INTENT_STORAGE_KEY, "1");
    } catch {
      // ignore
    }
    // Clear OpenPawlet handshake state so the next WS uses a fresh placeholder and
    // `ready.client_id` drives the new session; otherwise stale ids keep the old
    // connection key and sidebar selection.
    useAppStore.getState().setOpenPawletChatId(null);
    useAppStore.getState().setOpenPawletClientId(null);
    setCurrentSessionKey(null);
    setMessages([]);
    setShowSuggestions(true);
    setSubagentTasks([]);
    navigate("/chat");
    inputRef.current?.focus();
    newChatSidebarScrollUntilRef.current = Date.now() + 12000;
    setNewChatSidebarScrollToken((n) => n + 1);
    setSessionsSidebarOpen(true);
    setSessionsSidebarCollapsed(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleSelectSession = (sessionKey: string) => {
    setCurrentSessionKey(sessionKey);
    navigate(`/chat/${encodeURIComponent(sessionKey)}`);
    setSessionsSidebarOpen(false);
  };

  const openRenameSessionModal = (session: SessionInfo) => {
    setRenameSessionKey(session.key);
    setRenameSessionTitle(session.title || "");
    setRenameSessionModalOpen(true);
  };

  const handleRenameSessionSubmit = () => {
    const key = renameSessionKey?.trim();
    if (!key) {
      return;
    }
    renameSessionMutation.mutate({
      key,
      title: renameSessionTitle.trim(),
    });
  };

  const suggestions = useMemo(
    () => [
      {
        text: t("chat.suggestionReviewText"),
        label: t("chat.suggestionReviewLabel"),
      },
      {
        text: t("chat.suggestionAutomationText"),
        label: t("chat.suggestionAutomationLabel"),
      },
      {
        text: t("chat.suggestionScriptText"),
        label: t("chat.suggestionScriptLabel"),
      },
    ],
    [t],
  );

  /** Message time in agent-configured IANA timezone (matches OpenPawlet logs). */
  const formatMessageTime = (isoStr: string | undefined): string => {
    const locale = i18n.language.startsWith("zh") ? "zh-CN" : "en-US";
    return formatChatMessageTime(isoStr, agentTz, locale);
  };

  /** Show tail bubble for the whole in-flight turn, including warm-up before first token. */
  const showStreamingAssistantBubble = isStreaming;

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden overflow-x-hidden bg-white dark:bg-gray-950 relative">
      {/* Sessions Sidebar */}
      <div
        className={`
          ${sessionsSidebarOpen ? "translate-x-0" : "-translate-x-full"}
          ${sessionsSidebarCollapsed ? "md:-translate-x-full md:w-0 md:pointer-events-none md:overflow-hidden" : "md:translate-x-0 md:w-72"}
          fixed md:relative z-20 h-screen md:h-full
          w-72 bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800
          flex flex-col transition-transform duration-300 ease-out
        `}
      >
        <div className="h-12 shrink-0 px-3.5 flex items-center gap-3 border-b border-gray-200 dark:border-gray-800 min-w-0">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <span className="text-sm font-semibold text-gray-700 dark:text-gray-200 truncate min-w-0">
              {t("chat.sessionsTitle")}
            </span>
            {sessions && sessions.length > 0 ? (
              <div className="flex items-center gap-2 shrink-0">
                <Checkbox
                  indeterminate={
                    batchSelectedKeys.size > 0 &&
                    batchSelectedKeys.size < sessions.length
                  }
                  checked={sessions.every((s) =>
                    batchSelectedKeys.has(s.key),
                  )}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setBatchSelectedKeys(new Set(sessions.map((s) => s.key)));
                    } else {
                      setBatchSelectedKeys(new Set());
                    }
                  }}
                  title={t("chat.selectAll")}
                />
                {batchSelectedKeys.size > 0 ? (
                  <span
                    className="text-xs leading-none text-gray-500 dark:text-gray-400 tabular-nums min-w-[1.25rem]"
                    title={t("chat.selectedCount", {
                      count: batchSelectedKeys.size,
                    })}
                  >
                    {batchSelectedKeys.size}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
          <div className="flex items-center gap-0.5 shrink-0">
            {sessions && sessions.length > 0 ? (
              <Popconfirm
                title={t("chat.batchDeleteTitle")}
                description={t("chat.batchDeleteDesc", {
                  count: batchSelectedKeys.size,
                })}
                onConfirm={() =>
                  deleteSessionsBatchMutation.mutate([...batchSelectedKeys])
                }
                okText={t("common.delete")}
                cancelText={t("common.cancel")}
                okButtonProps={{ danger: true }}
                disabled={batchSelectedKeys.size === 0}
              >
                <Button
                  danger
                  type="text"
                  size="small"
                  icon={<DeleteOutlined />}
                  className="!w-9 !h-9 !min-w-9 flex items-center justify-center"
                  disabled={
                    batchSelectedKeys.size === 0 ||
                    deleteSessionsBatchMutation.isPending
                  }
                  loading={deleteSessionsBatchMutation.isPending}
                  title={t("chat.batchDelete")}
                />
              </Popconfirm>
            ) : null}
            <Button
              type="text"
              icon={<MenuFoldOutlined />}
              onClick={() => {
                setSessionsSidebarCollapsed(true);
                setSessionsSidebarOpen(false);
              }}
              className="!w-9 !h-9 !min-w-9 flex items-center justify-center"
              title={t("chat.collapseSidebar")}
            />
          </div>
        </div>
        <div className="shrink-0 px-3.5 py-2 border-b border-gray-200/50 dark:border-gray-700/50">
          <div className="flex items-center justify-end gap-2">
            <Tooltip title={t("chat.showSubagentSessionsHint")}>
              <Switch
                size="small"
                checked={showSubagentSessions}
                onChange={setShowSubagentSessions}
                checkedChildren={t("chat.showSubagentSwitchOn")}
                unCheckedChildren={t("chat.showSubagentSwitchOff")}
              />
            </Tooltip>
            <Tooltip title={t("chat.sessionDisplayModeHint")}>
              <Switch
                size="small"
                checked={isSessionDetailMode}
                onChange={(checked) =>
                  setSessionSidebarDisplayMode(checked ? "detail" : "compact")
                }
                checkedChildren={t("chat.sessionDisplayDetail")}
                unCheckedChildren={t("chat.sessionDisplayCompact")}
              />
            </Tooltip>
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar px-3.5 py-4 space-y-3">
          {sessionsListPending && sessions === undefined ? (
            <div className="flex flex-col items-center justify-center gap-3 py-16 text-gray-500 dark:text-gray-400">
              <Spin size="small" />
              <span className="text-xs">{t("chat.loadSessions")}</span>
            </div>
          ) : sessionsListError ? (
            <p className="text-sm text-center text-amber-700 dark:text-amber-300 px-2 py-6 leading-relaxed">
              {t("chat.sessionsLoadError")}
            </p>
          ) : !sessions?.length ? (
            <p className="text-sm text-center text-gray-500 dark:text-gray-400 px-2 py-10 leading-relaxed">
              {t("chat.sessionsEmpty")}
            </p>
          ) : null}
          {(
            [
              {
                key: "main" as const,
                label: t("chat.mainAgentSessions"),
                rows: groupedSessions.main,
              },
              {
                key: "teams" as const,
                label: t("chat.teamSessions"),
                rows: groupedSessions.teams,
              },
            ] as const
          ).map((group) => {
            if (!group.rows.length) {
              return null;
            }
            const expanded = sessionTreeExpanded[group.key];
            return (
              <div key={group.key} className="space-y-2">
                <button
                  type="button"
                  onClick={() =>
                    setSessionTreeExpanded((prev) => ({
                      ...prev,
                      [group.key]: !prev[group.key],
                    }))
                  }
                  className="w-full flex items-center justify-between px-2 py-1.5 rounded-md bg-gray-100/80 dark:bg-gray-700/40 hover:bg-gray-100 dark:hover:bg-gray-700/60 text-gray-700 dark:text-gray-200 transition-colors"
                >
                  <span className="inline-flex items-center gap-2 min-w-0">
                    {expanded ? (
                      <DownOutlined className="shrink-0 text-gray-500 dark:text-gray-300" />
                    ) : (
                      <RightOutlined className="shrink-0 text-gray-500 dark:text-gray-300" />
                    )}
                    <span className="text-xs font-semibold uppercase tracking-wide">
                      {group.label}
                    </span>
                  </span>
                  <span className="text-[11px] text-gray-500 dark:text-gray-400 tabular-nums">
                    {group.rows.length}
                  </span>
                </button>
                {expanded ? (
                  <div className="space-y-2 pl-3 border-l border-gray-200/80 dark:border-gray-700/80">
                    {group.rows.map((session) => (
                      <SessionSidebarItem
                        key={session.key}
                        session={session}
                        active={activeSessionKey === session.key}
                        detailMode={isSessionDetailMode}
                        checked={batchSelectedKeys.has(session.key)}
                        onSelect={() => handleSelectSession(session.key)}
                        onToggleChecked={(checked) => {
                          setBatchSelectedKeys((prev) => {
                            const next = new Set(prev);
                            if (checked) {
                              next.add(session.key);
                            } else {
                              next.delete(session.key);
                            }
                            return next;
                          });
                        }}
                        onRename={() => openRenameSessionModal(session)}
                        onDelete={() => deleteSessionMutation.mutate(session.key)}
                        registerRowRef={(el) => {
                          if (el) {
                            sessionSidebarRowRefs.current.set(session.key, el);
                          } else {
                            sessionSidebarRowRefs.current.delete(session.key);
                          }
                        }}
                        formatMessageTime={formatMessageTime}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
          {subAgentNodes.length > 0 ? (
            <div className="space-y-2">
              <button
                type="button"
                onClick={() =>
                  setSessionTreeExpanded((prev) => ({
                    ...prev,
                    subagents: !prev.subagents,
                  }))
                }
                className="w-full flex items-center justify-between px-2 py-1.5 rounded-md bg-gray-100/80 dark:bg-gray-700/40 hover:bg-gray-100 dark:hover:bg-gray-700/60 text-gray-700 dark:text-gray-200 transition-colors"
              >
                <span className="inline-flex items-center gap-2 min-w-0">
                  {sessionTreeExpanded.subagents ? (
                    <DownOutlined className="shrink-0 text-gray-500 dark:text-gray-300" />
                  ) : (
                    <RightOutlined className="shrink-0 text-gray-500 dark:text-gray-300" />
                  )}
                  <ApiOutlined className="shrink-0 text-emerald-500 dark:text-emerald-400" />
                  <span className="text-xs font-semibold uppercase tracking-wide">
                    {t("chat.subAgentSessions", "Sub Agents")}
                  </span>
                </span>
                <span className="text-[11px] text-gray-500 dark:text-gray-400 tabular-nums">
                  {subAgentNodes.reduce(
                    (sum, n) => sum + n.sessions.length + n.tasks.length,
                    0,
                  )}
                </span>
              </button>
              {sessionTreeExpanded.subagents ? (
                <div className="space-y-2 pl-3 border-l border-gray-200/80 dark:border-gray-700/80">
                  {subAgentNodes.map((node) => {
                    const nodeKey = node.key;
                    const nodeExpanded = expandedSubAgents.has(nodeKey);
                    const runningCt = node.tasks.filter(
                      (task) => task.status === "running",
                    ).length;
                    return (
                      <div key={nodeKey} className="space-y-1.5">
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedSubAgents((prev) => {
                              const next = new Set(prev);
                              if (next.has(nodeKey)) {
                                next.delete(nodeKey);
                              } else {
                                next.add(nodeKey);
                              }
                              return next;
                            })
                          }
                          className="w-full flex items-center justify-between px-2 py-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700/40 text-gray-700 dark:text-gray-200 transition-colors"
                        >
                          <span className="inline-flex items-center gap-2 min-w-0">
                            {nodeExpanded ? (
                              <DownOutlined className="shrink-0 text-gray-400" />
                            ) : (
                              <RightOutlined className="shrink-0 text-gray-400" />
                            )}
                            <RobotOutlined className="shrink-0 text-emerald-500 dark:text-emerald-400" />
                            <span className="text-sm font-medium truncate">
                              {node.name}
                            </span>
                            {runningCt > 0 ? (
                              <span className="inline-flex items-center gap-1 text-[11px] text-blue-600 dark:text-blue-300">
                                <LoadingOutlined spin />
                                {runningCt}
                              </span>
                            ) : null}
                          </span>
                          <span className="text-[11px] text-gray-500 dark:text-gray-400 tabular-nums">
                            {node.sessions.length + node.tasks.length}
                          </span>
                        </button>
                        {nodeExpanded ? (
                          <div className="pl-4 space-y-1.5">
                            {node.tasks.length > 0 ? (
                              <div className="space-y-1">
                                {node.tasks.map((task) => (
                                  <div
                                    key={task.id}
                                    className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-gray-50/60 dark:bg-gray-800/50 text-xs"
                                    title={task.task || task.label}
                                  >
                                    {task.status === "running" ? (
                                      <LoadingOutlined spin className="shrink-0 text-blue-500" />
                                    ) : task.status === "success" ? (
                                      <CheckCircleOutlined className="shrink-0 text-emerald-500" />
                                    ) : (
                                      <CloseOutlined className="shrink-0 text-red-500" />
                                    )}
                                    <span className="flex-1 truncate text-gray-700 dark:text-gray-200">
                                      {task.label}
                                    </span>
                                    {task.phase ? (
                                      <span className="text-[10px] text-gray-400">
                                        {task.phase}
                                      </span>
                                    ) : null}
                                  </div>
                                ))}
                              </div>
                            ) : null}
                            {node.sessions.map((session) => (
                              <SessionSidebarItem
                                key={session.key}
                                session={session}
                                active={activeSessionKey === session.key}
                                detailMode={isSessionDetailMode}
                                checked={batchSelectedKeys.has(session.key)}
                                compact
                                showSubagentTag={false}
                                leadingIcon={
                                  <MessageOutlined
                                    className="shrink-0 text-emerald-500 dark:text-emerald-400"
                                    aria-label="sub-agent session"
                                  />
                                }
                                onSelect={() => handleSelectSession(session.key)}
                                onToggleChecked={(checked) => {
                                  setBatchSelectedKeys((prev) => {
                                    const next = new Set(prev);
                                    if (checked) {
                                      next.add(session.key);
                                    } else {
                                      next.delete(session.key);
                                    }
                                    return next;
                                  });
                                }}
                                onRename={() => openRenameSessionModal(session)}
                                onDelete={() => deleteSessionMutation.mutate(session.key)}
                                registerRowRef={(el) => {
                                  if (el) {
                                    sessionSidebarRowRefs.current.set(
                                      session.key,
                                      el,
                                    );
                                  } else {
                                    sessionSidebarRowRefs.current.delete(
                                      session.key,
                                    );
                                  }
                                }}
                              />
                            ))}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {/* Mobile Overlay */}
      {sessionsSidebarOpen && (
        <div
          className="md:hidden fixed inset-0 bg-black/50 z-10"
          onClick={() => setSessionsSidebarOpen(false)}
        />
      )}

      {sessionsSidebarCollapsed && (
        <Button
          type="text"
          icon={<MenuUnfoldOutlined />}
          onClick={() => setSessionsSidebarCollapsed(false)}
          className="hidden md:flex absolute left-2 top-20 z-30 text-gray-500 hover:text-primary-500 bg-white/80 dark:bg-gray-900/80 rounded-full shadow"
          title={t("chat.expandSidebar")}
        />
      )}

      {/* Chat Area */}
      <div className="flex-1 flex min-w-0 min-h-0">
        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          {/* Header */}
          <div className="h-12 px-6 flex items-center justify-between border-b border-gray-200 dark:border-gray-800">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-md bg-blue-500 text-white">
                <RobotOutlined style={{ fontSize: 18 }} />
              </div>
              <div>
                <h2 className="text-lg font-semibold">{t("chat.title")}</h2>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {t("chat.subtitle")}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {activeSessionKey ? (
                <>
                  <Button
                    icon={<FileTextOutlined />}
                    onClick={() => {
                      setSessionJsonlFileSource("session");
                      setSessionContextTab("assembled");
                      setSessionJsonlModalOpen(true);
                    }}
                    className="hidden md:inline-flex"
                  >
                    {t("chat.viewContextJsonl")}
                  </Button>
                  <Button
                    shape="circle"
                    icon={<FileTextOutlined />}
                    onClick={() => {
                      setSessionJsonlFileSource("session");
                      setSessionContextTab("assembled");
                      setSessionJsonlModalOpen(true);
                    }}
                    className="md:!hidden shrink-0"
                    title={t("chat.viewContextJsonl")}
                    aria-label={t("chat.viewContextJsonl")}
                  />
                </>
              ) : null}
              {sessions && sessions.length > 0 && (
                <>
                  <Button
                    type="primary"
                    icon={<PlusOutlined />}
                    onClick={handleNewChat}
                    className="hidden md:inline-flex"
                  >
                    {t("chat.newChat")}
                  </Button>
                  <Button
                    type="primary"
                    shape="circle"
                    icon={<PlusOutlined />}
                    onClick={handleNewChat}
                    className="md:!hidden shrink-0"
                    title={t("chat.newChat")}
                    aria-label={t("chat.newChat")}
                  />
                </>
              )}
            </div>
          </div>

          {/* Messages / Hero */}
          {displayMessages.length === 0 && showSuggestions ? (
            <ChatHeroSuggestions
              suggestions={suggestions}
              onPickSuggestion={(text) => {
                setInput(text);
                inputRef.current?.focus();
              }}
              containerRef={messagesContainerRef}
            />
          ) : (
            <div className="relative flex-1 min-h-0 flex flex-col">
              <VirtualizedMessageList
                items={displayMessages}
                getKey={(msg) => msg.id}
                registerHandle={setVirtualListHandle}
                header={
                  historyHasMore || loadingOlder ? (
                    <div className="flex items-center justify-center py-2 text-xs text-gray-500 dark:text-gray-400">
                      {loadingOlder ? (
                        <span className="inline-flex items-center gap-2">
                          <LoadingOutlined />
                          {t("chat.loadingOlder")}
                        </span>
                      ) : historyHasMore ? (
                        <button
                          type="button"
                          onClick={() => void loadOlderHistoryPage()}
                          className="inline-flex items-center gap-2 rounded-full px-3 py-1 bg-gray-100 dark:bg-gray-700/60 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 transition-colors"
                        >
                          {t("chat.loadingOlder")}
                        </button>
                      ) : null}
                    </div>
                  ) : null
                }
                renderItem={(msg) => {
                  const isLatestPendingAskUser =
                    msg.id === latestPendingAskUserMsgId;
                  const extraAbove =
                    msg.role === "assistant" ? (
                      <>
                        {msg.reasoning_content ? (
                          <MessageThinkingBlock text={msg.reasoning_content} />
                        ) : null}
                        <MessageToolCallsBlock
                          noTopMargin={!msg.reasoning_content}
                          tool_calls={msg.tool_calls}
                          onAskUserAnswer={
                            isLatestPendingAskUser
                              ? handleAskUserAnswer
                              : undefined
                          }
                          askUserDisabled={isStreaming}
                        />
                      </>
                    ) : null;
                  const ts = msg.created_at ?? msg.timestamp;
                  return (
                    <MessageRow
                      msg={msg}
                      extraAbove={extraAbove}
                      formattedTime={ts ? formatMessageTime(ts) : null}
                    />
                  );
                }}
                footer={
                  <>
                    {showStreamingAssistantBubble && (
                      <StreamingAssistantBubble
                        streamingChannelNotices={streamingChannelNotices}
                        streamingReasoningContent={streamingReasoningContent}
                        streamingPayloadToolCalls={streamingPayloadToolCalls}
                        streamingContent={streamingContent}
                        streamingToolProgress={streamingToolProgress}
                        toolCalls={toolCalls}
                      />
                    )}
                    <div ref={messagesEndRef} />
                  </>
                }
              />

              {showJumpToBottom ? (
                <JumpToBottomButton
                  unreadBelowCount={unreadBelowCount}
                  onJump={jumpToBottom}
                />
              ) : null}
            </div>
          )}

          {/* Input */}
          <div className="relative bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-800 pb-safe">
            {/* Mobile: anchor above composer so height tracks textarea; left side avoids jump-to-bottom (right). */}
            <button
              type="button"
              onClick={() => setSessionsSidebarOpen(!sessionsSidebarOpen)}
              className="md:hidden absolute bottom-[calc(100%+0.5rem)] left-4 z-30 flex h-11 w-11 items-center justify-center rounded-full bg-blue-500 text-white shadow-md transition-colors hover:bg-blue-600"
              title={
                sessionsSidebarOpen
                  ? t("chat.closeSessions")
                  : t("chat.openSessions")
              }
              aria-label={
                sessionsSidebarOpen
                  ? t("chat.closeSessions")
                  : t("chat.openSessions")
              }
            >
              {sessionsSidebarOpen ? (
                <CloseOutlined style={{ fontSize: 18 }} />
              ) : (
                <MessageOutlined style={{ fontSize: 18 }} />
              )}
            </button>
            <div className="w-full min-w-0 max-w-3xl mx-auto px-4 md:px-6 py-4">
              <ChatInput
                inputRef={inputRef}
                value={input}
                onChange={setInput}
                onKeyDown={handleKeyDown}
                onSend={handleSend}
                onStop={handleStop}
                isStreaming={isStreaming}
                showContextMeter={useOpenPawletChannel}
                contextUsage={openpawletContextUsage}
                contextLoading={statusJsonLoading}
              />
            </div>
          </div>
        </div>

        {/* Subagent Panel */}
        {subagentTasks.length > 0 && (
          <SubagentPanel
            tasks={subagentTasks}
            collapsed={!subagentPanelOpen}
            onCollapse={() => setSubagentPanelOpen(false)}
          />
        )}
      </div>

      <Modal
        open={sessionJsonlModalOpen}
        onCancel={() => {
          setSessionJsonlModalOpen(false);
          // Intentionally do not ``removeQueries`` here: keeping the cached
          // snapshot lets the next open render instantly while a background
          // refetch (triggered by ``invalidateQueries`` in the open effect)
          // pulls any newer turn.
        }}
        title={t("chat.viewContextJsonl")}
        footer={null}
        width="min(100vw - 2rem, 48rem)"
        height="70vh"
        destroyOnHidden
        styles={{
          container: {
            height: "100%",
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
          },
          body: {
            display: "flex",
            flexDirection: "column",
            flex: 1,
            minHeight: 0,
            overflow: "hidden",
            padding: "8px 24px 20px",
          },
        }}
      >
        <Tabs
          activeKey={sessionContextTab}
          onChange={(k) =>
            setSessionContextTab(k === "raw" ? "raw" : "assembled")
          }
          className="flex min-h-0 flex-1 flex-col [&>.ant-tabs-content-holder]:flex-1 [&>.ant-tabs-content-holder]:min-h-0 [&_.ant-tabs-content]:h-full [&_.ant-tabs-tabpane]:h-full"
          destroyOnHidden
          items={[
            {
              key: "assembled",
              label: t("chat.contextAssembledTab"),
              children: (
                <div className="flex h-full min-h-0 flex-col gap-3">
                  <div className="flex w-full min-w-0 shrink-0 flex-wrap items-center gap-2">
                    <span className="min-w-0 text-sm text-gray-500 dark:text-gray-400">
                      {sessionContextHasRecord
                        ? sessionContextTurnIndex != null
                          ? t("chat.contextAssembledTurnInfo", {
                              index: sessionContextTurnIndex,
                              timestamp: sessionContextTimestamp ?? "",
                            })
                          : t("chat.contextAssembledLatest", {
                              timestamp: sessionContextTimestamp ?? "",
                            })
                        : t("chat.contextAssembledEmpty")}
                    </span>
                    <div className="ml-auto flex shrink-0 flex-wrap items-center gap-2">
                      {sessionContextFetching && !sessionContextPending ? (
                        <Spin size="small" />
                      ) : null}
                      <Button
                        type="primary"
                        icon={<CopyOutlined />}
                        disabled={!sessionContextLatestText}
                        onClick={() => {
                          if (sessionContextLatestText) {
                            void navigator.clipboard.writeText(
                              sessionContextLatestText,
                            );
                            addToast({
                              type: "success",
                              message: t("chat.contextJsonlCopied"),
                            });
                          }
                        }}
                      >
                        {t("chat.contextJsonlCopy")}
                      </Button>
                    </div>
                  </div>
                  {sessionContextPending ? (
                    <div className="flex min-h-0 flex-1 items-center justify-center">
                      <Spin />
                    </div>
                  ) : sessionContextError ? (
                    <p className="m-0 shrink-0 text-sm text-red-600 dark:text-red-400">
                      {t("chat.contextAssembledLoadError")}:{" "}
                      {sessionContextErr instanceof Error
                        ? sessionContextErr.message
                        : String(sessionContextErr)}
                    </p>
                  ) : !sessionContextHasRecord ? (
                    <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-gray-500 dark:text-gray-400">
                      {t("chat.contextAssembledEmptyHint")}
                    </div>
                  ) : (
                    <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-gray-200/90 bg-white dark:border-gray-600/80 dark:bg-[#1e1e1e]">
                      <CodeMirror
                        value={sessionContextLatestText}
                        height="100%"
                        className="h-full min-h-0 text-[13px] [&_.cm-editor]:!h-full [&_.cm-editor]:!max-h-full [&_.cm-scroller]:!overflow-auto [&_.cm-content]:!pb-3"
                        readOnly
                        theme={codeMirrorIsDark ? vscodeDark : vscodeLight}
                        extensions={sessionJsonlCmExtensions}
                        basicSetup={{
                          lineNumbers: true,
                          foldGutter: true,
                          highlightActiveLine: false,
                        }}
                      />
                    </div>
                  )}
                </div>
              ),
            },
            {
              key: "raw",
              label: t("chat.contextRawTab"),
              children: (
                <div className="flex h-full min-h-0 flex-col gap-3">
                  <div className="flex w-full min-w-0 shrink-0 flex-wrap items-center gap-2">
                    <span className="shrink-0 text-sm text-gray-500 dark:text-gray-400">
                      {t("chat.contextJsonlFileSource")}
                    </span>
                    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                      <Select
                        value={sessionJsonlFileSource}
                        onChange={(v) => setSessionJsonlFileSource(v)}
                        className="min-w-0 max-w-full flex-1 [&_.ant-select-selector]:!w-full"
                        options={[
                          {
                            value: "session",
                            label: t("chat.contextJsonlFileSession"),
                          },
                          {
                            value: "transcript",
                            label: t("chat.contextJsonlFileTranscript"),
                          },
                        ]}
                      />
                      {sessionJsonlFetching && !sessionJsonlPending ? (
                        <Spin size="small" />
                      ) : null}
                      <Button
                        type="primary"
                        icon={<CopyOutlined />}
                        disabled={!sessionJsonlData?.text}
                        onClick={() => {
                          if (sessionJsonlData?.text) {
                            void navigator.clipboard.writeText(
                              sessionJsonlData.text,
                            );
                            addToast({
                              type: "success",
                              message: t("chat.contextJsonlCopied"),
                            });
                          }
                        }}
                      >
                        {t("chat.contextJsonlCopy")}
                      </Button>
                    </div>
                  </div>
                  {sessionJsonlPending ? (
                    <div className="flex min-h-0 flex-1 items-center justify-center">
                      <Spin />
                    </div>
                  ) : sessionJsonlError ? (
                    <p className="m-0 shrink-0 text-sm text-red-600 dark:text-red-400">
                      {t("chat.contextJsonlLoadError")}:{" "}
                      {sessionJsonlErr instanceof Error
                        ? sessionJsonlErr.message
                        : String(sessionJsonlErr)}
                    </p>
                  ) : (
                    <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-gray-200/90 bg-white dark:border-gray-600/80 dark:bg-[#1e1e1e]">
                      <CodeMirror
                        value={sessionJsonlDisplayText}
                        height="100%"
                        className="h-full min-h-0 text-[13px] [&_.cm-editor]:!h-full [&_.cm-editor]:!max-h-full [&_.cm-scroller]:!overflow-auto [&_.cm-content]:!pb-3"
                        readOnly
                        theme={codeMirrorIsDark ? vscodeDark : vscodeLight}
                        extensions={sessionJsonlCmExtensions}
                        basicSetup={{
                          lineNumbers: true,
                          foldGutter: true,
                          highlightActiveLine: false,
                        }}
                      />
                    </div>
                  )}
                </div>
              ),
            },
          ]}
        />
      </Modal>
      <Modal
        open={renameSessionModalOpen}
        onCancel={() => {
          if (renameSessionMutation.isPending) {
            return;
          }
          setRenameSessionModalOpen(false);
          setRenameSessionKey(null);
          setRenameSessionTitle("");
        }}
        title={t("chat.renameSession")}
        onOk={handleRenameSessionSubmit}
        okText={t("common.save")}
        cancelText={t("common.cancel")}
        okButtonProps={{
          loading: renameSessionMutation.isPending,
          disabled: !renameSessionKey,
        }}
        destroyOnHidden
      >
        <div className="space-y-2">
          <p className="m-0 text-xs text-gray-500 dark:text-gray-400">
            {t("chat.renameSessionHint")}
          </p>
          <Input
            value={renameSessionTitle}
            maxLength={120}
            onPressEnter={(e) => {
              e.preventDefault();
              handleRenameSessionSubmit();
            }}
            onChange={(e) => setRenameSessionTitle(e.target.value)}
            placeholder={t("chat.renameSessionPlaceholder")}
          />
        </div>
      </Modal>
    </div>
  );
}
