import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Checkbox, Popconfirm, Tag, Tooltip } from "antd";
import {
  DeleteOutlined,
  EditOutlined,
  RobotOutlined,
  TeamOutlined,
} from "@ant-design/icons";

import type { SessionInfo } from "../../api/types";

interface SessionSidebarItemProps {
  session: SessionInfo;
  active: boolean;
  detailMode: boolean;
  checked: boolean;
  compact?: boolean;
  showSubagentTag?: boolean;
  leadingIcon?: ReactNode;
  leadingIconAriaLabel?: string;
  onSelect: () => void;
  onToggleChecked: (checked: boolean) => void;
  onRename: () => void;
  onDelete: () => void;
  registerRowRef?: (el: HTMLDivElement | null) => void;
  formatMessageTime?: (isoStr: string | undefined) => string;
}

function DefaultLeadingIcon({ session }: { session: SessionInfo }) {
  if (session.team_id) {
    return (
      <TeamOutlined
        className="shrink-0 text-blue-500 dark:text-blue-400"
        aria-label="team session"
      />
    );
  }
  return (
    <RobotOutlined
      className={`shrink-0 ${
        session.is_subagent
          ? "text-amber-500 dark:text-amber-400"
          : "text-violet-500 dark:text-violet-400"
      }`}
      aria-label={session.is_subagent ? "subagent session" : "agent session"}
    />
  );
}

export function SessionSidebarItem({
  session,
  active,
  detailMode,
  checked,
  compact = false,
  showSubagentTag = true,
  leadingIcon,
  leadingIconAriaLabel,
  onSelect,
  onToggleChecked,
  onRename,
  onDelete,
  registerRowRef,
  formatMessageTime,
}: SessionSidebarItemProps) {
  const { t } = useTranslation();
  const agentDisplay =
    (session.agent_name && session.agent_name.trim()) ||
    (session.agent_id && session.agent_id.trim()) ||
    "";
  const rowPaddingY = compact ? "py-2.5" : "py-3";
  const rowActionClass = compact
    ? "self-center shrink-0 w-8 h-8 my-1.5"
    : "self-center shrink-0 w-9 h-9 my-2";

  return (
    <div
      ref={registerRowRef}
      className={`flex items-stretch gap-2 rounded-md transition-colors ${
        active
          ? "bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300"
          : "hover:bg-gray-100 dark:hover:bg-gray-800"
      }`}
    >
      <div className={`flex items-center justify-center shrink-0 pl-3 pr-0.5 ${rowPaddingY}`}>
        <Checkbox
          checked={checked}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => {
            e.stopPropagation();
            onToggleChecked(e.target.checked);
          }}
        />
      </div>
      <button
        type="button"
        onClick={onSelect}
        className={`flex-1 min-w-0 text-left rounded-l-lg ${
          detailMode
            ? compact
              ? "py-2.5 pr-2"
              : "py-3.5 pr-2"
            : compact
              ? "py-2.5 pr-3"
              : "py-3 pr-3"
        }`}
      >
        {detailMode ? (
          <>
            <span className="flex items-center gap-1.5 min-w-0">
              {leadingIcon ? (
                <span aria-label={leadingIconAriaLabel}>{leadingIcon}</span>
              ) : (
                <DefaultLeadingIcon session={session} />
              )}
              <span className="text-sm font-medium truncate block leading-snug min-w-0">
                {session.title || session.key}
              </span>
              {agentDisplay ? (
                <span className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5 block leading-relaxed truncate">
                  {t("chat.sessionAgentLabel", { name: agentDisplay })}
                </span>
              ) : null}
              {showSubagentTag && session.is_subagent ? (
                <Tooltip
                  title={
                    session.parent_session_key
                      ? t("chat.subagentParent", {
                          parent: session.parent_session_key,
                        })
                      : t("chat.subagentTagHint")
                  }
                >
                  <Tag
                    color="orange"
                    className="!m-0 !text-[10px] !leading-4 !px-1 !py-0 shrink-0"
                  >
                    {t("chat.subagentTag")}
                  </Tag>
                </Tooltip>
              ) : null}
            </span>
            <span className="text-xs text-gray-500 mt-1 block leading-relaxed">
              {t("chat.messageCount", { count: session.message_count })}
            </span>
            <span className="text-[11px] text-gray-400 dark:text-gray-500 mt-1 block leading-relaxed font-mono truncate">
              ID: {session.key}
            </span>
            {session.created_at && formatMessageTime ? (
              <span className="text-xs text-gray-400 dark:text-gray-500 mt-1 block leading-relaxed">
                {formatMessageTime(session.created_at)}
              </span>
            ) : null}
          </>
        ) : (
          <span className="flex items-center justify-between gap-2 w-full min-w-0">
            <span className="flex flex-col gap-0.5 min-w-0 flex-1">
              <span className="text-sm font-medium truncate block leading-snug min-w-0">
                {session.title || session.key}
              </span>
              {agentDisplay ? (
                <span className="text-[11px] text-gray-500 dark:text-gray-400 truncate leading-snug">
                  {t("chat.sessionAgentLabel", { name: agentDisplay })}
                </span>
              ) : null}
            </span>
            <span className="text-[11px] text-gray-400 dark:text-gray-500 tabular-nums shrink-0 self-start mt-0.5">
              {session.message_count}
            </span>
          </span>
        )}
      </button>
      {detailMode ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRename();
          }}
          title={t("chat.renameSession")}
          className={`${rowActionClass} flex items-center justify-center rounded-md text-gray-400 hover:text-blue-500 hover:bg-blue-50 dark:text-gray-500 dark:hover:text-blue-300 dark:hover:bg-blue-500/10 transition-colors duration-150`}
        >
          <EditOutlined className={compact ? "" : "text-base"} />
        </button>
      ) : null}
      {detailMode ? (
        <Popconfirm
          title={t("chat.deleteSessionTitle")}
          description={t("chat.deleteSessionDesc", {
            name: session.title || session.key,
          })}
          onConfirm={onDelete}
          okText={t("common.delete")}
          cancelText={t("common.cancel")}
          okButtonProps={{ danger: true }}
        >
          <button
            type="button"
            onClick={(e) => e.stopPropagation()}
            title={t("chat.deleteSession")}
            className={`${rowActionClass} mr-2 flex items-center justify-center rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50 dark:text-gray-500 dark:hover:text-red-400 dark:hover:bg-red-500/10 transition-colors duration-150`}
          >
            <DeleteOutlined className={compact ? "" : "text-base"} />
          </button>
        </Popconfirm>
      ) : null}
    </div>
  );
}
