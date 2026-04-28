import { create } from 'zustand';
import type {
  ChannelStatus,
  MCPStatus,
  SessionInfo,
  StatusResponse,
  WSMessage,
} from '../api/types';

import { OPENPAWLET_LOCAL_STORAGE_KEYS } from '../constants/localStorage';

type Theme = 'light' | 'dark' | 'system';

type ToastType = 'success' | 'error' | 'info' | 'warning';

interface Toast {
  id: string;
  type: ToastType;
  message: string;
  duration?: number;
}

/** Ring-buffer cap for WebSocket debug panes (Console /ws + OpenPawlet channel); prevents unbounded memory. */
const WS_DEBUG_MAX_STORED_MESSAGES = 5000;

const THEME_STORAGE_KEY = OPENPAWLET_LOCAL_STORAGE_KEYS.theme;
const CURRENT_BOT_STORAGE_KEY = OPENPAWLET_LOCAL_STORAGE_KEYS.currentBotId;

const getInitialTheme = (): Theme => {
  const stored = localStorage.getItem(THEME_STORAGE_KEY) as Theme | null;
  if (stored) return stored;
  if (window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
  return 'light';
};

const applyTheme = (theme: Theme) => {
  const root = document.documentElement;
  if (theme === 'system') {
    const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    root.classList.toggle('dark', isDark);
  } else {
    root.classList.toggle('dark', theme === 'dark');
  }
};

// Apply initial theme
applyTheme(getInitialTheme());

// Listen for system theme changes
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  const currentTheme = useAppStore.getState().theme;
  if (currentTheme === 'system') {
    applyTheme('system');
  }
});

interface AppState {
  // UI State
  sidebarCollapsed: boolean;
  theme: Theme;
  currentSessionKey: string | null;
  currentBotId: string | null;

  // Data State
  status: StatusResponse | null;
  sessions: SessionInfo[];
  channels: ChannelStatus[];
  mcpServers: MCPStatus[];
  isLoading: boolean;
  error: string | null;

  // Toast notifications
  toasts: Toast[];

  // WebSocket (console push via VITE_CONSOLE_WS_URL)
  wsConnected: boolean;
  /** True while the socket is opening or handshaking (not yet OPEN). */
  wsConnecting: boolean;
  wsMessages: WSMessage[];
  /** Raw frames from OpenPawlet `/openpawlet-ws` (chat streaming channel); for debug UI only. */
  openpawletWsDebugLines: { ts: number; body: string }[];

  /** OpenPawlet built-in channel WS (Chat `/openpawlet-ws`); for header when console push is off. */
  agentWsLinked: boolean;
  agentWsReady: boolean;
  /** Raw `chat_id` from OpenPawlet `ready`; used as `chat_id` on outbound WS payloads. */
  openpawletChatId: string | null;
  /** `websocket:` + `ready.chat_id`; canonical session key for JSONL, routing, and outbound `session_key`. */
  openpawletClientId: string | null;

  // Actions
  setSidebarCollapsed: (collapsed: boolean) => void;
  setTheme: (theme: Theme) => void;
  setCurrentSessionKey: (key: string | null) => void;
  setCurrentBotId: (botId: string | null) => void;

  setStatus: (status: StatusResponse | null) => void;
  setSessions: (sessions: SessionInfo[]) => void;
  setChannels: (channels: ChannelStatus[]) => void;
  setMCPServers: (servers: MCPStatus[]) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;

  // Toast actions
  addToast: (toast: Omit<Toast, 'id'>) => void;
  removeToast: (id: string) => void;

  setWSConnected: (connected: boolean) => void;
  setWSConnecting: (connecting: boolean) => void;
  addWSMessage: (message: WSMessage) => void;
  clearWSMessages: () => void;
  addOpenPawletWsDebugLine: (body: string) => void;
  clearOpenPawletWsDebug: () => void;

  setAgentWsLinked: (linked: boolean) => void;
  setAgentWsReady: (ready: boolean) => void;
  setOpenPawletChatId: (chatId: string | null) => void;
  setOpenPawletClientId: (clientId: string | null) => void;
}

export const useAppStore = create<AppState>((set) => ({
  // Initial UI State
  sidebarCollapsed: false,
  theme: getInitialTheme(),
  currentSessionKey: null,
  currentBotId: localStorage.getItem(CURRENT_BOT_STORAGE_KEY) || null,

  // Initial Data State
  status: null,
  sessions: [],
  channels: [],
  mcpServers: [],
  isLoading: false,
  error: null,

  // Toast notifications
  toasts: [],

  // WebSocket
  wsConnected: false,
  wsConnecting: false,
  wsMessages: [],
  openpawletWsDebugLines: [],

  agentWsLinked: false,
  agentWsReady: false,
  openpawletChatId: null,
  openpawletClientId: null,

  // Actions
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  setTheme: (theme) => {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
    applyTheme(theme);
    set({ theme });
  },
  setCurrentSessionKey: (key) => set({ currentSessionKey: key }),
  setCurrentBotId: (botId) => {
    localStorage.setItem(CURRENT_BOT_STORAGE_KEY, botId || '');
    set({
      currentBotId: botId,
      currentSessionKey: null,
      openpawletChatId: null,
      openpawletClientId: null,
    });
  },

  setStatus: (status) => set({ status }),
  setSessions: (sessions) => set({ sessions }),
  setChannels: (channels) => set({ channels }),
  setMCPServers: (servers) => set({ mcpServers: servers }),
  setLoading: (loading) => set({ isLoading: loading }),
  setError: (error) => set({ error }),

  // Toast actions
  addToast: (toast) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const newToast = { ...toast, id };
    set((state) => ({ toasts: [...state.toasts, newToast] }));

    // Auto remove after duration
    const duration = toast.duration ?? 4000;
    if (duration > 0) {
      setTimeout(() => {
        set((state) => ({
          toasts: state.toasts.filter((t) => t.id !== id),
        }));
      }, duration);
    }
  },
  removeToast: (id) =>
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    })),

  setWSConnected: (connected) => set({ wsConnected: connected }),
  setWSConnecting: (connecting) => set({ wsConnecting: connecting }),
  addWSMessage: (message) =>
    set((state) => {
      const next = [...state.wsMessages, message];
      return {
        wsMessages:
          next.length > WS_DEBUG_MAX_STORED_MESSAGES
            ? next.slice(-WS_DEBUG_MAX_STORED_MESSAGES)
            : next,
      };
    }),
  clearWSMessages: () => set({ wsMessages: [] }),
  addOpenPawletWsDebugLine: (body) =>
    set((state) => {
      const line = { ts: Date.now(), body: body.slice(0, 8000) };
      const next = [...state.openpawletWsDebugLines, line];
      return {
        openpawletWsDebugLines:
          next.length > WS_DEBUG_MAX_STORED_MESSAGES
            ? next.slice(-WS_DEBUG_MAX_STORED_MESSAGES)
            : next,
      };
    }),
  clearOpenPawletWsDebug: () => set({ openpawletWsDebugLines: [] }),

  setAgentWsLinked: (linked) => set({ agentWsLinked: linked }),
  setAgentWsReady: (ready) => set({ agentWsReady: ready }),
  setOpenPawletChatId: (chatId) => set({ openpawletChatId: chatId }),
  setOpenPawletClientId: (clientId) => set({ openpawletClientId: clientId }),
}));
