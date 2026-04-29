import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Avatar,
  Button,
  Empty,
  Form,
  Input,
  Popconfirm,
  Select,
  Spin,
  Switch,
  Typography,
  Modal,
  Tooltip,
  Drawer,
} from 'antd';
import {
  ArrowLeftOutlined,
  EditOutlined,
  ReloadOutlined,
  CommentOutlined,
  UserAddOutlined,
  DownOutlined,
  RightOutlined,
  NumberOutlined,
  MoreOutlined,
  PlusOutlined,
  ThunderboltOutlined,
  TeamOutlined,
  CloseOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../store';
import { PageLayout } from '../components/PageLayout';
import { PAGE_PRIMARY_TITLE_CLASS } from '../utils/pageTitleClasses';
import * as api from '../api/client';
import type { MergedTranscriptEntry, TeamUpdateRequest } from '../api/types_teams';

const { TextArea } = Input;

function formatRoomChip(id: string): string {
  if (id.length <= 14) return id;
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

function memberAvatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const hues = [262, 217, 199, 152, 200];
  return `hsl(${hues[h % hues.length]}, 55%, 46%)`;
}

function formatMessageTime(iso: string | null, locale: string): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleString(locale.startsWith('zh') ? 'zh-CN' : undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function dayLabelForMessage(iso: string | null, locale: string): string | null {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(locale.startsWith('zh') ? 'zh-CN' : undefined, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  } catch {
    return null;
  }
}

function dayKey(iso: string | null): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  } catch {
    return '';
  }
}

function rolePillClass(role: string): string {
  switch (role) {
    case 'user':
      return 'bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-200';
    case 'assistant':
      return 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-200';
    case 'system':
      return 'bg-amber-100 text-amber-900 dark:bg-amber-950/50 dark:text-amber-200';
    case 'tool':
      return 'bg-violet-100 text-violet-800 dark:bg-violet-950/50 dark:text-violet-200';
    default:
      return 'bg-zinc-200 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200';
  }
}

function roleBubbleClass(role: string): string {
  switch (role) {
    case 'user':
      return 'bg-sky-50/90 text-zinc-800 shadow-sm ring-1 ring-sky-200/50 dark:bg-sky-950/20 dark:text-zinc-100 dark:ring-sky-800/30';
    case 'assistant':
      return 'bg-white text-zinc-800 shadow-sm ring-1 ring-zinc-200/60 dark:bg-zinc-800/50 dark:text-zinc-100 dark:ring-zinc-600/30';
    case 'system':
      return 'bg-amber-50/80 text-amber-950 shadow-sm ring-1 ring-amber-200/40 dark:bg-amber-950/20 dark:text-amber-100 dark:ring-amber-800/30';
    case 'tool':
      return 'bg-violet-50/80 text-violet-950 shadow-sm ring-1 ring-violet-200/40 dark:bg-violet-950/30 dark:text-violet-100 dark:ring-violet-800/25';
    default:
      return 'bg-zinc-50 text-zinc-800 shadow-sm ring-1 ring-zinc-200/50 dark:bg-zinc-800/40 dark:text-zinc-100 dark:ring-zinc-600/25';
  }
}

export default function TeamDetail() {
  const { teamId: teamIdParam } = useParams();
  const navigate = useNavigate();
  const teamId = teamIdParam ? decodeURIComponent(teamIdParam) : '';
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const { currentBotId, addToast } = useAppStore();
  const [roomId, setRoomId] = useState<string | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);

  const { data: team, isLoading: teamLoading } = useQuery({
    queryKey: ['team', currentBotId, teamId],
    queryFn: () => api.getTeam(currentBotId!, teamId),
    enabled: !!currentBotId && !!teamId,
  });

  const { data: skillsList } = useQuery({
    queryKey: ['skills', currentBotId],
    queryFn: () => api.listSkills(currentBotId!),
    enabled: !!currentBotId,
  });

  const { data: agents = [] } = useQuery({
    queryKey: ['agents', currentBotId],
    queryFn: () => api.listAgents(currentBotId!),
    enabled: !!currentBotId,
  });

  const { data: rooms = [], isLoading: roomsLoading } = useQuery({
    queryKey: ['team-rooms', currentBotId, teamId],
    queryFn: () => api.listTeamRooms(currentBotId!, teamId),
    enabled: !!currentBotId && !!teamId,
  });

  const { data: transcript, isLoading: trLoading, refetch: refetchTr } = useQuery({
    queryKey: ['team-transcript', currentBotId, teamId, roomId],
    queryFn: () => api.getTeamRoomTranscript(currentBotId!, teamId, roomId!),
    enabled: !!currentBotId && !!teamId && !!roomId,
  });

  useEffect(() => {
    if (roomsLoading) return;
    if (rooms.length === 0) {
      setRoomId(null);
      return;
    }
    if (!roomId || !rooms.some((r) => r.id === roomId)) {
      setRoomId(rooms[0].id);
    }
  }, [rooms, roomsLoading, roomId]);

  useEffect(() => {
    if (!transcript?.messages?.length) return;
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcript?.messages, roomId, trLoading]);

  const agentNameById = useMemo(() => {
    const m: Record<string, string> = {};
    agents.forEach((a) => {
      m[a.id] = a.name;
    });
    return m;
  }, [agents]);

  const addMemberMut = useMutation({
    mutationFn: (agentId: string) => api.addTeamMember(currentBotId!, teamId, agentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['team', currentBotId, teamId] });
      addToast({ type: 'success', message: t('teams.memberAdded') });
    },
    onError: (e: Error) => addToast({ type: 'error', message: e.message }),
  });

  const removeMemberMut = useMutation({
    mutationFn: (agentId: string) => api.removeTeamMember(currentBotId!, teamId, agentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['team', currentBotId, teamId] });
      addToast({ type: 'success', message: t('teams.memberRemoved') });
    },
    onError: (e: Error) => addToast({ type: 'error', message: e.message }),
  });

  const updateMemberMut = useMutation({
    mutationFn: (payload: { agentId: string; ephemeralSession: boolean }) =>
      api.updateTeamMember(currentBotId!, teamId, payload.agentId, {
        ephemeral_session: payload.ephemeralSession,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['team', currentBotId, teamId] });
      addToast({ type: 'success', message: t('teams.memberSessionModeSaved') });
    },
    onError: (e: Error) => addToast({ type: 'error', message: e.message }),
  });

  const createRoomMut = useMutation({
    mutationFn: () => api.createTeamRoom(currentBotId!, teamId),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['team-rooms', currentBotId, teamId] });
      setRoomId(res.room.id);
      addToast({ type: 'success', message: t('teams.roomCreated') });
    },
    onError: (e: Error) => addToast({ type: 'error', message: e.message }),
  });

  const deleteRoomMut = useMutation({
    mutationFn: (targetRoomId: string) => api.deleteTeamRoom(currentBotId!, teamId, targetRoomId),
    onSuccess: (_, targetRoomId) => {
      queryClient.invalidateQueries({ queryKey: ['team-rooms', currentBotId, teamId] });
      queryClient.removeQueries({
        queryKey: ['team-transcript', currentBotId, teamId, targetRoomId],
      });
      if (roomId === targetRoomId) {
        const nextRoom = rooms.find((r) => r.id !== targetRoomId);
        setRoomId(nextRoom?.id ?? null);
      }
      addToast({ type: 'success', message: t('teams.roomDeleted') });
    },
    onError: (e: Error) => addToast({ type: 'error', message: e.message }),
  });

  const [addMemberOpen, setAddMemberOpen] = useState(false);
  const [pickAgent, setPickAgent] = useState<string | undefined>();
  const [contextEditOpen, setContextEditOpen] = useState(false);
  const [editContextNotes, setEditContextNotes] = useState('');
  const [editTeamSkills, setEditTeamSkills] = useState<string[]>([]);
  const [profileCollapsed, setProfileCollapsed] = useState(true);
  const [membersCollapsed, setMembersCollapsed] = useState(true);
  const [infoDrawerOpen, setInfoDrawerOpen] = useState(false);

  const updateTeamMut = useMutation({
    mutationFn: (body: TeamUpdateRequest) => api.updateTeam(currentBotId!, teamId, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['team', currentBotId, teamId] });
      addToast({ type: 'success', message: t('teams.contextSaved') });
      setContextEditOpen(false);
    },
    onError: (e: Error) => addToast({ type: 'error', message: e.message }),
  });

  const availableToAdd = useMemo(() => {
    if (!team) return [];
    const set = new Set(team.member_agent_ids);
    return agents.filter((a) => a.enabled && !set.has(a.id));
  }, [team, agents]);

  if (!currentBotId) {
    return (
      <PageLayout variant="bleed">
        <Empty description={t('agents.selectBotFirst')} className="py-20" />
      </PageLayout>
    );
  }

  if (teamLoading || !team) {
    return (
      <PageLayout>
        <div className="flex justify-center py-20">
          <Spin size="large" />
        </div>
      </PageLayout>
    );
  }

  const messageRows = (transcript?.messages || []) as MergedTranscriptEntry[];

  return (
    <PageLayout
      variant="bleed"
      className="!h-full !min-h-0 !gap-0 !p-0 flex flex-1 flex-col overflow-hidden bg-zinc-100/90 dark:bg-zinc-950"
    >
      {/* Channel header: calm bar + identity */}
      <header className="flex shrink-0 items-center gap-3 border-b border-zinc-200/80 bg-white/90 px-3 py-3 shadow-[0_1px_0_0_rgba(0,0,0,0.03)] backdrop-blur-md dark:border-zinc-800/80 dark:bg-zinc-900/90 sm:gap-4 sm:px-5">
        <Link
          to="/agents?section=teams"
          className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-zinc-500 transition-all hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-50"
          title={t('teams.backToList')}
        >
          <ArrowLeftOutlined className="text-lg" />
        </Link>
        <div className="relative flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500 to-indigo-600 text-base font-bold text-white shadow-md shadow-violet-500/20 ring-4 ring-violet-500/10 dark:ring-violet-400/10">
          {team.name.trim().charAt(0).toUpperCase() || '?'}
        </div>
        <div className="min-w-0 flex-1">
          <h1 className={`truncate ${PAGE_PRIMARY_TITLE_CLASS}`}>
            {team.name}
          </h1>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-zinc-500 dark:text-zinc-400">
            <span className="line-clamp-2 max-w-full sm:line-clamp-1">
              {team.description?.trim() || t('teams.noDescription')}
            </span>
            <span className="hidden text-zinc-300 sm:inline dark:text-zinc-600" aria-hidden>
              |
            </span>
            <span className="inline-flex items-center gap-1 text-zinc-600 dark:text-zinc-300">
              <TeamOutlined className="opacity-70" />
              {t('teams.memberCount', { count: team.member_agent_ids.length })}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="large"
            shape="round"
            onClick={() => setInfoDrawerOpen(true)}
            className="h-10 max-w-[calc(100vw-8rem)] rounded-full border-zinc-200 bg-white px-4 text-zinc-700 hover:!border-violet-300 hover:!text-violet-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:!border-violet-700 dark:hover:!text-violet-300 sm:max-w-none"
          >
            <span className="block max-w-[9rem] truncate sm:max-w-none">{t('teams.teamProfile')}</span>
          </Button>
          <Tooltip title={t('teams.addMember')}>
            <Button
              type="primary"
              shape="round"
              size="large"
              icon={<UserAddOutlined />}
              aria-label={t('teams.addMember')}
              onClick={() => setAddMemberOpen(true)}
              disabled={availableToAdd.length === 0}
              className="h-10 border-0 bg-violet-600 px-4 shadow-sm shadow-violet-500/20 hover:!bg-violet-500 dark:bg-violet-600"
            >
              <span className="hidden sm:inline">{t('teams.addMember')}</span>
            </Button>
          </Tooltip>
        </div>
      </header>

      {/* Main workspace */}
      <div className="flex min-h-0 flex-1 flex-col gap-px bg-zinc-200/50 dark:bg-zinc-800/30">
        {/* Transcript — paper column */}
        <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,rgba(139,92,246,0.08),transparent)] dark:bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,rgba(139,92,246,0.12),transparent)]">
          <div className="shrink-0 border-b border-zinc-200/70 bg-white/90 px-3 py-1.5 backdrop-blur-sm dark:border-zinc-800/60 dark:bg-zinc-900/65 sm:px-4">
            <div className="flex items-center gap-2">
              <div className="inline-flex !h-7 shrink-0 items-center rounded-full bg-zinc-100 px-2.5 text-[11px] font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
                <CommentOutlined className="mr-1 text-[10px]" />
                {roomId
                  ? t('teams.messageCount', { count: messageRows.length })
                  : t('teams.noRoom')}
              </div>

              <div className="min-w-0 flex-1 overflow-x-auto">
                {roomsLoading ? (
                  <div className="flex items-center py-1">
                    <Spin size="small" />
                  </div>
                ) : rooms.length === 0 ? (
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('teams.noRooms')}</p>
                ) : (
                  <div className="flex h-8 items-center gap-1.5">
                    <span className="inline-flex !h-8 shrink-0 items-center text-[10px] font-medium text-zinc-500 dark:text-zinc-400">
                      <NumberOutlined className="mr-1" />
                      {t('teams.roomLabel')}
                    </span>
                    {rooms.map((r) => {
                      const active = roomId === r.id;
                      return (
                        <div
                          key={r.id}
                          onClick={() => setRoomId(r.id)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              setRoomId(r.id);
                            }
                          }}
                          role="button"
                          tabIndex={0}
                          className={[
                            'group inline-flex !h-7 shrink-0 cursor-pointer items-center gap-1 rounded-full pl-2.5 pr-1 text-[11px] font-medium leading-none transition-colors',
                            active
                              ? 'bg-violet-100 text-violet-700 ring-1 ring-violet-200 dark:bg-violet-900/35 dark:text-violet-200 dark:ring-violet-700/50'
                              : 'bg-white text-zinc-600 ring-1 ring-zinc-200 hover:bg-zinc-50 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-700 dark:hover:bg-zinc-700/80',
                          ].join(' ')}
                        >
                          <NumberOutlined />
                          <span className="font-mono">{formatRoomChip(r.id)}</span>
                          <Popconfirm
                            title={t('teams.deleteRoomTitle')}
                            description={t('teams.deleteRoomDesc', { roomId: r.id })}
                            okText={t('common.delete')}
                            cancelText={t('common.cancel')}
                            placement="top"
                            onConfirm={() => deleteRoomMut.mutate(r.id)}
                            onPopupClick={(e) => e.stopPropagation()}
                            disabled={deleteRoomMut.isPending}
                          >
                            <button
                              type="button"
                              onClick={(e) => e.stopPropagation()}
                              className="ml-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-black/5 hover:text-red-500 group-hover:opacity-100 dark:hover:bg-white/10 dark:hover:text-red-400"
                              aria-label={t('teams.deleteRoom')}
                              disabled={deleteRoomMut.isPending}
                            >
                              <CloseOutlined />
                            </button>
                          </Popconfirm>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="flex shrink-0 items-center gap-1.5">
                <Tooltip title={t('teams.newRoom')}>
                  <Button
                    type="default"
                    size="middle"
                    icon={<PlusOutlined />}
                    loading={createRoomMut.isPending}
                    onClick={() => createRoomMut.mutate()}
                    disabled={team.member_agent_ids.length === 0}
                    className="!h-8 !w-8 rounded-md border-zinc-200 p-0 text-zinc-600 hover:!border-violet-300 hover:!text-violet-600 dark:border-zinc-600 dark:text-zinc-300 dark:hover:!border-violet-600 dark:hover:!text-violet-300"
                  />
                </Tooltip>
                <Button
                  icon={<ReloadOutlined />}
                  size="middle"
                  aria-label={t('teams.refreshTranscript')}
                  onClick={() => refetchTr()}
                  loading={trLoading}
                  disabled={!roomId}
                  className="!h-8 shrink-0 rounded-md border-zinc-200 px-2.5 text-xs text-zinc-700 hover:!border-violet-300 hover:!text-violet-600 dark:border-zinc-600 dark:text-zinc-200 dark:hover:!border-violet-600 dark:hover:!text-violet-300"
                >
                  <span className="hidden sm:inline">{t('teams.refreshTranscript')}</span>
                </Button>
              </div>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
            <div className="mx-auto min-h-full max-w-3xl px-3 py-4 sm:px-5 sm:py-5">
            {!roomId ? (
              <div className="flex min-h-[200px] flex-col items-center justify-center rounded-2xl border border-dashed border-zinc-200/80 bg-white/50 py-10 dark:border-zinc-800 dark:bg-zinc-900/30">
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('teams.noRooms')} />
              </div>
            ) : trLoading ? (
              <div className="flex justify-center py-20">
                <Spin />
              </div>
            ) : !messageRows.length ? (
              <div className="flex min-h-[200px] flex-col items-center justify-center rounded-2xl border border-dashed border-zinc-200/80 bg-white/50 py-10 dark:border-zinc-800 dark:bg-zinc-900/30">
                <Empty description={t('teams.transcriptEmpty')} />
              </div>
            ) : (
              <div className="space-y-0">
                {messageRows.map((row, i) => {
                  const displayName = row.agent_name || row.agent_id;
                  const initial = displayName.trim().charAt(0).toUpperCase() || '?';
                  const dk = dayKey(row.timestamp);
                  const prevDk = i > 0 ? dayKey(messageRows[i - 1].timestamp) : null;
                  const showDayDivider = Boolean(dk && dk !== prevDk);
                  const dayLabel = dayLabelForMessage(row.timestamp, i18n.language);

                  return (
                    <div key={`${row.session_key}-${i}`}>
                      {showDayDivider && dayLabel ? (
                        <div
                          className="sticky top-0 z-10 my-4 flex items-center gap-3 py-1"
                          role="separator"
                        >
                          <div className="h-px flex-1 bg-gradient-to-r from-transparent via-zinc-200 to-transparent dark:via-zinc-600" />
                          <span className="shrink-0 rounded-full bg-zinc-100/95 px-3 py-0.5 text-center text-[11px] font-medium text-zinc-500 shadow-sm ring-1 ring-zinc-200/80 dark:bg-zinc-800/95 dark:text-zinc-400 dark:ring-zinc-600/50">
                            {dayLabel}
                          </span>
                          <div className="h-px flex-1 bg-gradient-to-r from-transparent via-zinc-200 to-transparent dark:via-zinc-600" />
                        </div>
                      ) : null}
                      <div className="group flex gap-3 rounded-xl py-2 pl-0.5 pr-1 transition-colors hover:bg-zinc-100/50 dark:hover:bg-zinc-800/30">
                        <div className="pt-0.5">
                          <Avatar
                            size={40}
                            className="!border-2 !border-white !shadow-sm dark:!border-zinc-800"
                            style={{ backgroundColor: memberAvatarColor(row.agent_id) }}
                          >
                            {initial}
                          </Avatar>
                        </div>
                        <div className="min-w-0 flex-1 pb-1">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                            <span className="text-[15px] font-semibold text-zinc-900 dark:text-zinc-50">
                              {displayName}
                            </span>
                            <span
                              className={[
                                'rounded-md px-1.5 py-0 text-[10px] font-semibold uppercase tracking-wide',
                                rolePillClass(row.role),
                              ].join(' ')}
                            >
                              {row.role}
                            </span>
                            <time
                              className="text-[11px] tabular-nums text-zinc-400 dark:text-zinc-500"
                              dateTime={row.timestamp || undefined}
                            >
                              {formatMessageTime(row.timestamp, i18n.language)}
                            </time>
                          </div>
                          <div
                            className={[
                              'mt-1.5 max-w-full rounded-2xl rounded-tl-md px-3.5 py-2.5 text-[13px] leading-[1.55]',
                              roleBubbleClass(row.role),
                            ].join(' ')}
                          >
                            <div className="whitespace-pre-wrap break-words font-normal">{row.content}</div>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
                <div ref={transcriptEndRef} className="h-1" aria-hidden />
              </div>
            )}

            </div>
          </div>
        </section>

      </div>

      <Drawer
        title={t('teams.teamProfile')}
        placement="right"
        size={360}
        open={infoDrawerOpen}
        onClose={() => setInfoDrawerOpen(false)}
        extra={
          <Button
            type="text"
            size="small"
            className="!text-violet-600 dark:!text-violet-400"
            icon={<EditOutlined />}
            onClick={() => {
              setEditContextNotes(team.context_notes || '');
              setEditTeamSkills([...(team.team_skills || [])]);
              setContextEditOpen(true);
            }}
          >
            {t('teams.editContext')}
          </Button>
        }
      >
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
          <div className="overflow-hidden rounded-xl border border-zinc-200/70 bg-white shadow-sm dark:border-zinc-700/50 dark:bg-zinc-800/30">
            <button
              type="button"
              className="flex w-full items-center justify-between px-3 py-2.5 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/70"
              onClick={() => setProfileCollapsed((v) => !v)}
            >
              <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-500 dark:text-zinc-400">
                {t('teams.contextCard')}
              </span>
              {profileCollapsed ? (
                <RightOutlined className="text-zinc-400" />
              ) : (
                <DownOutlined className="text-zinc-400" />
              )}
            </button>
            {!profileCollapsed && (
              <div className="space-y-3 border-t border-zinc-200/60 p-3 dark:border-zinc-700/50">
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-400 dark:text-zinc-500">
                    {t('teams.contextNotes')}
                  </p>
                  <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-zinc-700 dark:text-zinc-200">
                    {team.context_notes || <span className="text-zinc-400 dark:text-zinc-500">—</span>}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-400 dark:text-zinc-500">
                    {t('teams.teamSkills')}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {team.team_skills?.length ? (
                      team.team_skills.map((s) => (
                        <span
                          key={s}
                          className="inline-flex items-center gap-1 rounded-lg bg-violet-100/90 px-2 py-1 text-xs font-medium text-violet-900 dark:bg-violet-950/50 dark:text-violet-200"
                        >
                          <ThunderboltOutlined className="opacity-80" />
                          {s}
                        </span>
                      ))
                    ) : (
                      <span className="text-sm text-zinc-400">—</span>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="mt-3 overflow-hidden rounded-xl border border-zinc-200/70 bg-white shadow-sm dark:border-zinc-700/50 dark:bg-zinc-800/30">
            <button
              type="button"
              className="flex w-full items-center justify-between px-3 py-2.5 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/70"
              onClick={() => setMembersCollapsed((v) => !v)}
            >
              <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-500 dark:text-zinc-400">
                {t('teams.membersTitle')}
              </span>
              <span className="ml-2 rounded-full bg-zinc-200/80 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-zinc-600 dark:bg-zinc-700 dark:text-zinc-200">
                {team.member_agent_ids.length}
              </span>
              {membersCollapsed ? (
                <RightOutlined className="ml-2 text-zinc-400" />
              ) : (
                <DownOutlined className="ml-2 text-zinc-400" />
              )}
            </button>
            {!membersCollapsed && (
              <div className="border-t border-zinc-200/60 p-3 dark:border-zinc-700/50">
                {team.member_agent_ids.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-zinc-200/80 py-6 dark:border-zinc-700/80">
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('teams.noMembers')} />
                  </div>
                ) : (
                  <ul className="space-y-0.5">
                    {team.member_agent_ids.map((id) => {
                      const label = agentNameById[id] || id;
                      const initial = label.trim().charAt(0).toUpperCase() || '?';
                      return (
                        <li
                          key={id}
                          className="group flex items-center gap-2 rounded-xl px-2 py-1.5 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/60"
                        >
                          <Avatar
                            size={36}
                            className="!border-2 !border-white !shadow dark:!border-zinc-800"
                            style={{ backgroundColor: memberAvatarColor(id) }}
                          >
                            {initial}
                          </Avatar>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[13px] font-semibold text-zinc-900 dark:text-zinc-100">
                              {label}
                            </div>
                            <Tooltip title={id}>
                              <div className="truncate font-mono text-[10px] text-zinc-400 dark:text-zinc-500">
                                {formatRoomChip(id)}
                              </div>
                            </Tooltip>
                          </div>
                          <Popconfirm
                            title={t('teams.confirmRemoveMember')}
                            okText={t('common.confirm')}
                            cancelText={t('common.cancel')}
                            onConfirm={() => removeMemberMut.mutate(id)}
                          >
                            <Button
                              type="text"
                              danger
                              size="small"
                              icon={<MoreOutlined />}
                              loading={removeMemberMut.isPending}
                              className="!h-8 !w-8 !p-0 opacity-40 transition-opacity group-hover:opacity-100"
                              title={t('teams.removeMember')}
                            />
                          </Popconfirm>
                          <div className="ml-1 flex items-center gap-1">
                            <span className="text-[10px] text-zinc-400 dark:text-zinc-500">
                              {t('teams.ephemeralSession')}
                            </span>
                            <Switch
                              size="small"
                              checked={!!team.member_ephemeral?.[id]}
                              loading={updateMemberMut.isPending}
                              onChange={(checked) =>
                                updateMemberMut.mutate({ agentId: id, ephemeralSession: checked })
                              }
                            />
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}

                {roomId && transcript?.member_session_keys && Object.keys(transcript.member_session_keys).length > 0 ? (
                  <div className="mt-3 rounded-xl border border-violet-200/60 bg-violet-50/60 p-3 dark:border-violet-900/50 dark:bg-violet-950/20">
                    <p className="text-xs font-medium text-zinc-600 dark:text-zinc-300">
                      {t('teams.chatWithMemberHint')}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {Object.entries(transcript.member_session_keys).map(([aid, sk]) => (
                        <Button
                          key={aid}
                          type="default"
                          size="small"
                          icon={<CommentOutlined className="text-violet-600 dark:text-violet-400" />}
                          className="!rounded-full !border-violet-200/80 !bg-white !font-medium shadow-sm hover:!border-violet-300 hover:!text-violet-800 dark:!border-violet-800 dark:!bg-zinc-800 dark:hover:!border-violet-600"
                          onClick={async () => {
                            const ephemeralSession = !!team.member_ephemeral?.[aid];
                            let targetKey = sk;
                            if (ephemeralSession) {
                              const created = await api.createSession(
                                {
                                  team_id: teamId,
                                  room_id: roomId || undefined,
                                  agent_id: aid,
                                  ephemeral_session: true,
                                },
                                currentBotId!,
                              );
                              targetKey = created.key;
                            }
                            navigate(`/chat/${encodeURIComponent(targetKey)}`, {
                              state: { fromTeam: teamId, roomId },
                            });
                          }}
                        >
                          {agentNameById[aid] || aid}
                        </Button>
                      ))}
                    </div>
                    <Typography.Paragraph type="secondary" className="!mb-0 !mt-2 text-[11px] leading-relaxed">
                      {t('teams.sessionKeysHint')}
                    </Typography.Paragraph>
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </div>
      </Drawer>

      <Modal
        title={t('teams.editContext')}
        open={contextEditOpen}
        onCancel={() => setContextEditOpen(false)}
        destroyOnHidden
        width={560}
        okText={t('common.save')}
        okButtonProps={{
          className:
            'rounded-lg bg-gradient-to-r from-violet-600 to-indigo-600 border-0 hover:from-violet-500 hover:to-indigo-500',
          loading: updateTeamMut.isPending,
        }}
        onOk={() => {
          updateTeamMut.mutate({
            context_notes: editContextNotes.trim() || null,
            team_skills: editTeamSkills,
          });
        }}
      >
        <Form layout="vertical" className="mt-2">
          <Form.Item label={t('teams.contextNotes')}>
            <TextArea
              rows={5}
              value={editContextNotes}
              onChange={(e) => setEditContextNotes(e.target.value)}
              className="rounded-lg"
            />
          </Form.Item>
          <Form.Item
            label={t('teams.teamSkills')}
            extra={<span className="text-slate-500 dark:text-slate-400">{t('teams.teamSkillsHelp')}</span>}
          >
            <Select
              mode="multiple"
              className="w-full"
              placeholder={t('agents.skillsPlaceholder')}
              value={editTeamSkills}
              onChange={setEditTeamSkills}
              allowClear
              options={(skillsList || []).map((s) => ({ value: s.name, label: s.name }))}
            />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={t('teams.addMember')}
        open={addMemberOpen}
        destroyOnHidden
        onCancel={() => {
          setAddMemberOpen(false);
          setPickAgent(undefined);
        }}
        okButtonProps={{
          className:
            'rounded-lg bg-gradient-to-r from-violet-600 to-indigo-600 border-0 hover:from-violet-500 hover:to-indigo-500',
        }}
        onOk={() => {
          if (!pickAgent) return;
          addMemberMut.mutate(pickAgent);
          setAddMemberOpen(false);
          setPickAgent(undefined);
        }}
        okText={t('common.confirm')}
      >
        <Select
          className="mt-2 w-full"
          size="large"
          placeholder={t('teams.pickAgent')}
          value={pickAgent}
          onChange={setPickAgent}
          options={availableToAdd.map((a) => ({ value: a.id, label: a.name }))}
        />
      </Modal>
    </PageLayout>
  );
}
