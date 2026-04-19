import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Spin,
  Alert,
  Tag,
  Modal,
  Form,
  Input,
  Switch,
  Popconfirm,
} from 'antd';
import {
  ReloadOutlined,
  InfoCircleOutlined,
  EditOutlined,
  DeleteOutlined,
} from '@ant-design/icons';
import {
  Send,
  MessageCircle,
  Briefcase,
  Phone,
  FileText,
  Bell,
  Mail,
  Gamepad2,
  Grid3x3,
  PlugZap,
  Building2,
  MonitorSmartphone,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import * as api from '../api/client';
import { useAppStore } from '../store';

// Common config fields for token-based channels
const CHANNEL_TOKEN_FIELDS: Record<string, string[]> = {
  telegram: ['token', 'proxy', 'allow_from'],
  discord: ['token', 'allow_from'],
  slack: ['bot_token', 'app_token', 'allow_from'],
  qq: ['app_id', 'secret', 'allow_from'],
  feishu: ['app_id', 'app_secret', 'allow_from'],
  dingtalk: ['client_id', 'client_secret', 'allow_from'],
  whatsapp: ['bridge_url', 'bridge_token', 'allow_from'],
  mochat: ['claw_token', 'agent_user_id', 'allow_from'],
  matrix: ['homeserver', 'user_id', 'access_token', 'device_id', 'allow_from'],
  email: ['imap_host', 'imap_username', 'smtp_host', 'smtp_username', 'from_address', 'allow_from'],
};

function formatAllowFrom(val: unknown): string {
  if (Array.isArray(val)) return val.join(', ');
  if (typeof val === 'string') return val;
  return '';
}

function parseAllowFrom(s: string): string[] {
  return s
    .split(/[,;\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

const CHANNEL_ICONS: Record<string, LucideIcon> = {
  telegram: Send,
  discord: Gamepad2,
  slack: Briefcase,
  whatsapp: Phone,
  feishu: FileText,
  dingtalk: Bell,
  email: Mail,
  qq: MessageCircle,
  matrix: Grid3x3,
  mochat: MessageCircle,
  websocket: PlugZap,
  weixin: MessageCircle,
  wecom: Building2,
  msteams: MonitorSmartphone,
};

/** Top accent strip (full color gradient) */
const CHANNEL_TOP_BAR: Record<string, string> = {
  telegram: 'from-sky-500 via-blue-500 to-cyan-400',
  discord: 'from-indigo-500 via-violet-500 to-purple-500',
  slack: 'from-amber-500 via-orange-500 to-rose-500',
  whatsapp: 'from-emerald-500 via-green-500 to-teal-400',
  feishu: 'from-blue-500 via-cyan-500 to-sky-400',
  dingtalk: 'from-blue-600 via-sky-500 to-cyan-500',
  email: 'from-slate-500 via-slate-400 to-zinc-400',
  qq: 'from-amber-400 via-yellow-400 to-orange-400',
  matrix: 'from-violet-600 via-purple-500 to-fuchsia-500',
  mochat: 'from-teal-500 via-emerald-500 to-green-400',
  websocket: 'from-amber-500 via-orange-400 to-yellow-400',
  weixin: 'from-green-500 via-emerald-500 to-lime-400',
  wecom: 'from-blue-600 via-blue-500 to-indigo-500',
  msteams: 'from-violet-600 via-indigo-500 to-blue-600',
  default: 'from-slate-400 to-slate-600',
};

/** Icon tile when channel is enabled (approximate brand colors) */
const CHANNEL_ICON_BG: Record<string, string> = {
  telegram: 'bg-[#229ED9] text-white shadow-sm',
  discord: 'bg-[#5865F2] text-white shadow-sm',
  slack: 'bg-[#4A154B] text-white shadow-sm',
  whatsapp: 'bg-[#25D366] text-white shadow-sm',
  feishu: 'bg-[#3370FF] text-white shadow-sm',
  dingtalk: 'bg-[#0089FF] text-white shadow-sm',
  email: 'bg-slate-600 text-white shadow-sm dark:bg-slate-500',
  qq: 'bg-[#12B7F5] text-white shadow-sm',
  matrix: 'bg-zinc-900 text-white shadow-sm dark:bg-black',
  mochat: 'bg-teal-600 text-white shadow-sm',
  websocket: 'bg-amber-500 text-white shadow-sm',
  weixin: 'bg-[#07C160] text-white shadow-sm',
  wecom: 'bg-[#0082EF] text-white shadow-sm',
  msteams: 'bg-[#6264A7] text-white shadow-sm',
  default: 'bg-gradient-to-br from-slate-500 to-slate-700 text-white shadow-sm',
};

const ICON_BG_DISABLED =
  'bg-slate-200/95 text-slate-500 shadow-inner dark:bg-slate-700/90 dark:text-slate-400';

function ChannelIcon({ name, size = 24, className }: { name: string; size?: number; className?: string }) {
  const Icon = CHANNEL_ICONS[name] || MessageCircle;
  return <Icon size={size} strokeWidth={1.75} className={className} />;
}

export default function Channels() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { addToast, currentBotId } = useAppStore();
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editingChannel, setEditingChannel] = useState<string | null>(null);
  const [form] = Form.useForm();

  const { data: channels, isLoading, error, refetch } = useQuery({
    queryKey: ['channels', currentBotId],
    queryFn: () => api.getChannels(currentBotId),
  });

  const { data: config } = useQuery({
    queryKey: ['config', currentBotId],
    queryFn: () => api.getConfig(currentBotId),
    enabled: editModalOpen,
  });

  const updateMutation = useMutation({
    mutationFn: async ({ name, data }: { name: string; data: Record<string, unknown> }) =>
      api.updateChannel(name, data, currentBotId),
    onSuccess: (_, { name }) => {
      addToast({ type: 'success', message: t('channels.updated', { name }) });
      queryClient.invalidateQueries({ queryKey: ['channels'] });
      queryClient.invalidateQueries({ queryKey: ['config'] });
      setEditModalOpen(false);
      setEditingChannel(null);
      form.resetFields();
    },
    onError: (e) => {
      addToast({ type: 'error', message: String(e) });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (name: string) => api.deleteChannel(name, currentBotId),
    onSuccess: (_, name) => {
      addToast({ type: 'success', message: t('channels.disabled', { name }) });
      queryClient.invalidateQueries({ queryKey: ['channels'] });
      queryClient.invalidateQueries({ queryKey: ['config'] });
    },
    onError: (e) => {
      addToast({ type: 'error', message: String(e) });
    },
  });

  const channelDescriptions: Record<string, string> = {
    telegram: 'Telegram Bot API',
    discord: 'Discord Developer Platform',
    slack: 'Slack App Platform',
    whatsapp: 'WhatsApp Business API',
    feishu: 'Feishu Open Platform',
    dingtalk: 'DingTalk Open API',
    email: 'IMAP / SMTP',
    qq: 'QQ Bot Platform',
    matrix: 'Matrix',
    mochat: 'MoChat Enterprise',
    websocket: 'WebSocket',
    weixin: 'Weixin Open Platform',
    wecom: 'WeCom',
    msteams: 'Microsoft Teams',
  };

  const statusColor = (status: string) => {
    if (status === 'online') return 'success';
    if (status === 'error') return 'error';
    return 'default';
  };

  const statusLabel = (status: string) => {
    if (status === 'online') return t('channels.statusOnline');
    if (status === 'offline') return t('channels.statusOffline');
    if (status === 'error') return t('channels.statusError');
    return status;
  };

  const openEditModal = (name: string) => {
    setEditingChannel(name);
    setEditModalOpen(true);
  };

  useEffect(() => {
    if (!editModalOpen || !editingChannel || !config) return;
    const ch = (config.channels as Record<string, Record<string, unknown>>)?.[editingChannel];
    const raw = (ch || {}) as Record<string, unknown>;
    // Support both snake_case and camelCase from config
    const get = (k: string) => raw[k] ?? raw[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())];
    const fields = CHANNEL_TOKEN_FIELDS[editingChannel] || ['token', 'allow_from'];
    const values: Record<string, unknown> = {
      enabled: get('enabled') !== false,
    };
    for (const f of fields) {
      if (f === 'allow_from') {
        values.allow_from = formatAllowFrom(get('allow_from'));
      } else {
        values[f] = get(f) ?? '';
      }
    }
    form.setFieldsValue(values);
  }, [editModalOpen, editingChannel, config, form]);

  const handleEditSubmit = () => {
    if (!editingChannel) return;
    form.validateFields().then((values) => {
      const data: Record<string, unknown> = {
        enabled: values.enabled,
      };
      const fields = CHANNEL_TOKEN_FIELDS[editingChannel] || ['token', 'allow_from'];
      for (const f of fields) {
        if (f === 'allow_from') {
          const arr = parseAllowFrom(values.allow_from || '');
          if (arr.length > 0) data.allow_from = arr;
        } else if (values[f] !== undefined && values[f] !== '') {
          data[f] = values[f];
        }
      }
      updateMutation.mutate({ name: editingChannel, data });
    });
  };

  if (isLoading) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <Spin size="large" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <Alert
          type="error"
          message={t('channels.errorLoad')}
          description={String(error)}
          showIcon
        />
      </div>
    );
  }

  const sortedChannels = [...(channels || [])].sort((a, b) =>
    a.enabled === b.enabled ? 0 : a.enabled ? -1 : 1
  );
  const totalChannels = channels?.length ?? 0;
  const enabledTotal = channels?.filter((c) => c.enabled).length ?? 0;

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-[1600px] flex-1 flex-col gap-8 p-6">
      <header className="flex shrink-0 flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
            {t('channels.pageTitle')}
          </h1>
          <p className="max-w-xl text-base text-slate-600 dark:text-slate-400">
            {t('channels.pageSubtitle')}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {totalChannels > 0 && (
            <div className="rounded-full border border-slate-200/90 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm dark:border-slate-600 dark:bg-slate-800/80 dark:text-slate-200">
              {t('channels.summary', { enabled: enabledTotal, total: totalChannels })}
            </div>
          )}
          <Button
            type="primary"
            icon={<ReloadOutlined />}
            onClick={() => refetch()}
            className="shadow-md shadow-primary-500/15"
          >
            {t('common.refresh')}
          </Button>
        </div>
      </header>

      <Alert
        type="info"
        showIcon
        icon={<InfoCircleOutlined />}
        message={t('channels.configAlert')}
        className="shrink-0 rounded-xl border-0 bg-sky-50/90 dark:bg-sky-950/35"
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
      {channels && channels.length > 0 ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
          {sortedChannels.map((channel) => {
            const topBar = CHANNEL_TOP_BAR[channel.name] || CHANNEL_TOP_BAR.default;
            const iconShell = channel.enabled
              ? CHANNEL_ICON_BG[channel.name] || CHANNEL_ICON_BG.default
              : ICON_BG_DISABLED;
            return (
              <div
                key={channel.name}
                className={`
                  group relative flex h-full flex-col overflow-hidden rounded-2xl border border-slate-200/90 bg-white shadow-sm shadow-slate-900/[0.04] transition-all duration-300 dark:border-slate-700 dark:bg-slate-900/40
                  hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-xl dark:hover:border-slate-600
                  ${!channel.enabled ? 'opacity-[0.92]' : ''}
                `}
              >
                <div
                  className={`h-1 w-full bg-gradient-to-r ${channel.enabled ? topBar : 'from-slate-300 to-slate-400 dark:from-slate-600 dark:to-slate-700'}`}
                />

                <div className="flex flex-1 flex-col gap-3 p-4 pt-3">
                  <div className="flex gap-3">
                    <div
                      className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl transition-transform duration-300 group-hover:scale-[1.03] ${iconShell}`}
                    >
                      <ChannelIcon name={channel.name} size={22} className={channel.enabled ? 'text-white' : undefined} />
                    </div>
                    <div className="min-w-0 flex-1 pr-6">
                      <h3 className="truncate text-base font-semibold capitalize tracking-tight text-slate-900 dark:text-slate-50">
                        {channel.name}
                      </h3>
                      <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                        {channelDescriptions[channel.name] || t('channels.typeFallback')}
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span
                      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                        channel.enabled
                          ? 'bg-emerald-500/12 text-emerald-800 dark:text-emerald-300'
                          : 'bg-slate-200/90 text-slate-600 dark:bg-slate-700/80 dark:text-slate-300'
                      }`}
                    >
                      {channel.enabled ? t('common.enabled') : t('common.disabled')}
                    </span>
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`inline-block h-2 w-2 shrink-0 rounded-full ${
                          channel.status === 'online'
                            ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.65)]'
                            : channel.status === 'error'
                              ? 'bg-red-500'
                              : 'bg-slate-400 dark:bg-slate-500'
                        }`}
                        title={statusLabel(channel.status)}
                      />
                      <Tag color={statusColor(channel.status)} className="m-0 border-0 text-xs font-medium">
                        {statusLabel(channel.status)}
                      </Tag>
                    </div>
                  </div>

                  <div className="mt-auto flex gap-2 border-t border-slate-100 pt-3 dark:border-slate-800">
                    <Button
                      type="default"
                      size="small"
                      icon={<EditOutlined />}
                      onClick={() => openEditModal(channel.name)}
                      className="flex-1 font-medium"
                    >
                      {t('channels.edit')}
                    </Button>
                    {channel.enabled && (
                      <Popconfirm
                        title={t('channels.disableConfirmTitle')}
                        description={t('channels.disableConfirmDesc')}
                        onConfirm={(e) => {
                          e?.stopPropagation();
                          deleteMutation.mutate(channel.name);
                        }}
                        okText={t('channels.disable')}
                        cancelText={t('common.cancel')}
                      >
                        <Button type="default" size="small" danger icon={<DeleteOutlined />} className="flex-1 font-medium">
                          {t('channels.disable')}
                        </Button>
                      </Popconfirm>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="rounded-2xl border-2 border-dashed border-slate-200 bg-gradient-to-b from-slate-50/80 to-white px-8 py-20 text-center dark:border-slate-700 dark:from-slate-900/40 dark:to-slate-900/20">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-100 text-3xl dark:bg-slate-800">
            📡
          </div>
          <p className="text-lg font-semibold text-slate-800 dark:text-slate-100">{t('channels.emptyTitle')}</p>
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">{t('channels.emptyDesc')}</p>
        </div>
      )}
      </div>

      <Modal
        title={
          editingChannel ? (
            <span className="flex items-center gap-2">
              <ChannelIcon name={editingChannel} size={20} className="text-slate-600 dark:text-slate-400" />
              <span>{t('channels.editModalTitle', { name: editingChannel })}</span>
            </span>
          ) : null
        }
        open={editModalOpen}
        onCancel={() => {
          setEditModalOpen(false);
          setEditingChannel(null);
          form.resetFields();
        }}
        onOk={handleEditSubmit}
        confirmLoading={updateMutation.isPending}
        okText={t('common.save')}
        width={520}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" className="mt-4">
          <Form.Item name="enabled" label={t('channels.formEnabled')} valuePropName="checked">
            <Switch />
          </Form.Item>
          {editingChannel &&
            (CHANNEL_TOKEN_FIELDS[editingChannel] || ['token', 'allow_from']).map((field) => {
              if (field === 'allow_from') {
                return (
                  <Form.Item
                    key={field}
                    name={field}
                    label={t('channels.formAllowFrom')}
                    help={t('channels.formAllowFromHelp')}
                  >
                    <Input.TextArea rows={2} placeholder="user1, user2, @username" />
                  </Form.Item>
                );
              }
              const isSecret = field.includes('token') || field.includes('secret') || field.includes('password');
              const label = field.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
              return (
                <Form.Item key={field} name={field} label={label}>
                  {isSecret ? (
                    <Input.Password autoComplete="off" placeholder="••••••••" />
                  ) : (
                    <Input placeholder={label} />
                  )}
                </Form.Item>
              );
            })}
        </Form>
      </Modal>
    </div>
  );
}
