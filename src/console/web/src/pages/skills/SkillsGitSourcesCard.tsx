import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Divider,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Segmented,
  Spin,
  Switch,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  BranchesOutlined,
  CloudSyncOutlined,
  DeleteOutlined,
  EditOutlined,
  GithubOutlined,
  KeyOutlined,
  PlusOutlined,
  ReloadOutlined,
  SafetyOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import * as api from '../../api/client';
import { useAppStore } from '../../store';
import { formatQueryError } from '../../utils/errors';
import type {
  SkillsGitAuth,
  SkillsGitAuthKind,
  SkillsGitRepo,
  SkillsGitRepoKind,
  SkillsGitRepoUpsertBody,
} from '../../api/types';

const { Text } = Typography;

interface Props {
  currentBotId?: string | null;
  /** Invalidate the parent ``skills`` list after a successful sync. */
  onSkillsChanged?: () => void;
  /**
   * Bare mode: drop the outer card frame / header / subtitle so the panel can
   * be embedded inside an external section (e.g. a Collapse panel). Action
   * buttons are kept inline above the list.
   */
  bare?: boolean;
  /** Notify the parent how many repositories are configured (for headers). */
  onRepoCountChange?: (count: number) => void;
}

interface RepoFormValues {
  name: string;
  url: string;
  branch?: string;
  kind: SkillsGitRepoKind;
  target?: string;
  authKind: SkillsGitAuthKind;
  tokenEnv?: string;
  username?: string;
  sshKeyPath?: string;
  sshPassphraseEnv?: string;
  autoUpdate: boolean;
  intervalMinutes: number;
}

const DEFAULT_FORM: RepoFormValues = {
  name: '',
  url: '',
  branch: '',
  kind: 'single',
  target: '',
  authKind: 'none',
  tokenEnv: '',
  username: '',
  sshKeyPath: '',
  sshPassphraseEnv: '',
  autoUpdate: false,
  intervalMinutes: 60,
};

function repoToFormValues(repo: SkillsGitRepo): RepoFormValues {
  return {
    name: repo.name,
    url: repo.url,
    branch: repo.branch ?? '',
    kind: repo.kind,
    target: repo.target ?? '',
    authKind: repo.auth?.kind ?? 'none',
    tokenEnv: repo.auth?.token_env ?? '',
    username: repo.auth?.username ?? '',
    sshKeyPath: repo.auth?.ssh_key_path ?? '',
    sshPassphraseEnv: repo.auth?.ssh_passphrase_env ?? '',
    autoUpdate: repo.auto_update,
    intervalMinutes: repo.interval_minutes,
  };
}

function formValuesToBody(values: RepoFormValues): SkillsGitRepoUpsertBody {
  const auth: SkillsGitAuth = { kind: values.authKind };
  if (values.authKind === 'token') {
    auth.token_env = values.tokenEnv?.trim() || null;
    auth.username = values.username?.trim() || null;
  } else if (values.authKind === 'ssh') {
    auth.ssh_key_path = values.sshKeyPath?.trim() || null;
    auth.ssh_passphrase_env = values.sshPassphraseEnv?.trim() || null;
  }
  return {
    name: values.name.trim(),
    url: values.url.trim(),
    branch: values.branch?.trim() ? values.branch.trim() : null,
    kind: values.kind,
    target: values.target?.trim() ? values.target.trim() : null,
    auth,
    auto_update: values.autoUpdate,
    interval_minutes: values.intervalMinutes,
  };
}

function StatusTag({ repo, t }: { repo: SkillsGitRepo; t: (k: string) => string }) {
  if (!repo.last_sync_status) {
    return (
      <Tag color="default" className="!m-0">
        {t('skillsGit.statusNever')}
      </Tag>
    );
  }
  if (repo.last_sync_status === 'ok') {
    return (
      <Tag color="success" className="!m-0">
        {t('skillsGit.statusOk')}
      </Tag>
    );
  }
  if (repo.last_sync_status === 'pending') {
    return (
      <Tag color="processing" className="!m-0" icon={<SyncOutlined spin />}>
        {t('skillsGit.statusSyncing')}
      </Tag>
    );
  }
  return (
    <Tag color="error" className="!m-0">
      {t('skillsGit.statusError')}
    </Tag>
  );
}

function formatRelative(iso: string | null | undefined, t: (k: string) => string): string {
  if (!iso) return t('skillsGit.lastSyncNever');
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return iso;
  return dt.toLocaleString();
}

export function SkillsGitSourcesCard({
  currentBotId,
  onSkillsChanged,
  bare = false,
  onRepoCountChange,
}: Props) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const addToast = useAppStore((s) => s.addToast);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingRepo, setEditingRepo] = useState<SkillsGitRepo | null>(null);
  const [form] = Form.useForm<RepoFormValues>();
  const watchedAuthKind = Form.useWatch('authKind', form) as SkillsGitAuthKind | undefined;
  const watchedKind = Form.useWatch('kind', form) as SkillsGitRepoKind | undefined;
  const watchedAutoUpdate = Form.useWatch('autoUpdate', form) as boolean | undefined;

  const { data: repos = [], isLoading } = useQuery({
    queryKey: ['skills-git', currentBotId],
    queryFn: () => api.listSkillsGitRepos(currentBotId),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['skills-git'] });
    if (onSkillsChanged) onSkillsChanged();
  };

  const createMutation = useMutation({
    mutationFn: (body: SkillsGitRepoUpsertBody) =>
      api.createSkillsGitRepo(body, currentBotId),
    onSuccess: () => {
      addToast({ type: 'success', message: t('skillsGit.savedToast') });
      setModalOpen(false);
      setEditingRepo(null);
      form.resetFields();
      invalidate();
    },
    onError: (e) => addToast({ type: 'error', message: formatQueryError(e) }),
  });

  const updateMutation = useMutation({
    mutationFn: (vars: { id: string; body: SkillsGitRepoUpsertBody }) =>
      api.updateSkillsGitRepo(vars.id, vars.body, currentBotId),
    onSuccess: () => {
      addToast({ type: 'success', message: t('skillsGit.savedToast') });
      setModalOpen(false);
      setEditingRepo(null);
      form.resetFields();
      invalidate();
    },
    onError: (e) => addToast({ type: 'error', message: formatQueryError(e) }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteSkillsGitRepo(id, currentBotId),
    onSuccess: () => {
      addToast({ type: 'success', message: t('skillsGit.deletedToast') });
      invalidate();
    },
    onError: (e) => addToast({ type: 'error', message: formatQueryError(e) }),
  });

  const syncMutation = useMutation({
    mutationFn: (id: string) => api.syncSkillsGitRepo(id, currentBotId),
    onSuccess: (result) => {
      if (result.status === 'ok') {
        addToast({
          type: 'success',
          message: t('skillsGit.syncedToast', {
            count: result.synced_skills.length,
          }),
        });
      } else {
        addToast({ type: 'error', message: result.message });
      }
      invalidate();
    },
    onError: (e) => addToast({ type: 'error', message: formatQueryError(e) }),
  });

  const syncAllMutation = useMutation({
    mutationFn: () => api.syncAllSkillsGitRepos(currentBotId),
    onSuccess: (results) => {
      const ok = results.filter((r) => r.status === 'ok').length;
      const fail = results.length - ok;
      addToast({
        type: fail > 0 ? 'warning' : 'success',
        message: t('skillsGit.syncAllToast', { ok, fail }),
      });
      invalidate();
    },
    onError: (e) => addToast({ type: 'error', message: formatQueryError(e) }),
  });

  const openCreate = () => {
    setEditingRepo(null);
    form.resetFields();
    form.setFieldsValue(DEFAULT_FORM);
    setModalOpen(true);
  };

  const openEdit = (repo: SkillsGitRepo) => {
    setEditingRepo(repo);
    form.resetFields();
    form.setFieldsValue(repoToFormValues(repo));
    setModalOpen(true);
  };

  const submitForm = (values: RepoFormValues) => {
    const body = formValuesToBody(values);
    if (!body.url) {
      addToast({ type: 'warning', message: t('skillsGit.urlRequired') });
      return;
    }
    if (!body.name) body.name = body.url;
    if (editingRepo) {
      updateMutation.mutate({ id: editingRepo.id, body });
    } else {
      createMutation.mutate(body);
    }
  };

  const submitting = createMutation.isPending || updateMutation.isPending;

  const repoList = useMemo(
    () =>
      [...repos].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    [repos],
  );

  useEffect(() => {
    onRepoCountChange?.(repoList.length);
  }, [repoList.length, onRepoCountChange]);

  const toolbar = (
    <div className="flex items-center gap-2 shrink-0">
      <Tooltip title={t('skillsGit.syncAllTooltip')}>
        <Button
          size="middle"
          icon={<ReloadOutlined />}
          onClick={() => syncAllMutation.mutate()}
          loading={syncAllMutation.isPending}
          disabled={repoList.length === 0}
        >
          <span className="hidden sm:inline">{t('skillsGit.syncAll')}</span>
        </Button>
      </Tooltip>
      <Button
        type="primary"
        size="middle"
        icon={<PlusOutlined />}
        onClick={openCreate}
        className="shadow-md shadow-primary-500/25"
      >
        <span className="hidden sm:inline">{t('skillsGit.addRepo')}</span>
        <span className="sm:hidden">{t('skills.addRepoShort')}</span>
      </Button>
    </div>
  );

  const containerClass = bare
    ? 'shrink-0'
    : 'p-4 rounded-md border border-gray-200/80 dark:border-gray-700/60 bg-white dark:bg-gray-800/40 shrink-0';

  return (
    <div className={containerClass}>
      {!bare && (
        <>
          <div className="flex items-center justify-between gap-2 mb-2">
            <div className="flex items-center gap-2 min-w-0">
              <GithubOutlined className="text-primary-500 dark:text-primary-400" />
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100 m-0 truncate">
                {t('skillsGit.title')}
              </p>
            </div>
            {toolbar}
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-3 m-0">
            {t('skillsGit.subtitle')}
          </p>
        </>
      )}

      {bare && (
        <div className="flex items-center justify-between gap-2 mb-3">
          <p className="text-xs text-gray-500 dark:text-gray-400 m-0">
            {t('skillsGit.subtitle')}
          </p>
          {toolbar}
        </div>
      )}

      {isLoading ? (
        <div className="flex justify-center py-8">
          <Spin />
        </div>
      ) : repoList.length === 0 ? (
        <div className="rounded-md border border-dashed border-gray-200 dark:border-gray-600/80 bg-gray-50/80 dark:bg-gray-900/30 py-4 px-4">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={t('skillsGit.empty')}
            styles={{ image: { height: 40 } }}
          />
        </div>
      ) : (
        <div className="space-y-2">
          {repoList.map((repo) => (
            <div
              key={repo.id}
              className="
                group flex flex-col gap-3 px-4 py-3 rounded-md
                border border-gray-200/70 dark:border-gray-700/60
                bg-white dark:bg-gray-800/60
                hover:border-primary-300/60 dark:hover:border-primary-500/40
                hover:shadow-md hover:shadow-primary-500/5 dark:hover:shadow-primary-500/10
                transition-all duration-200
                sm:flex-row sm:items-center sm:justify-between
              "
            >
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <div className="flex-shrink-0 w-9 h-9 rounded-md bg-gradient-to-br from-primary-50 to-primary-100 dark:from-primary-900/40 dark:to-primary-800/30 flex items-center justify-center">
                  <BranchesOutlined className="text-primary-500 dark:text-primary-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 min-w-0">
                    <p className="font-semibold text-gray-900 dark:text-gray-100 truncate m-0">
                      {repo.name}
                    </p>
                    <Tag
                      color={repo.kind === 'single' ? 'blue' : 'purple'}
                      className="!m-0 shrink-0"
                    >
                      {repo.kind === 'single'
                        ? t('skillsGit.kindSingle')
                        : t('skillsGit.kindMulti')}
                    </Tag>
                    {repo.auto_update && (
                      <Tag color="cyan" className="!m-0 shrink-0">
                        {t('skillsGit.autoTag', { mins: repo.interval_minutes })}
                      </Tag>
                    )}
                  </div>
                  <Text type="secondary" className="text-xs font-mono break-all">
                    {repo.url}
                    {repo.branch ? ` · ${repo.branch}` : ''}
                  </Text>
                  <div className="flex flex-wrap items-center gap-2 mt-1 text-xs">
                    <StatusTag repo={repo} t={t} />
                    <span className="text-gray-500 dark:text-gray-400">
                      {t('skillsGit.lastSyncAt', {
                        time: formatRelative(repo.last_sync_at, t),
                      })}
                    </span>
                    {repo.last_commit_sha && (
                      <span className="text-gray-400 dark:text-gray-500 font-mono">
                        {repo.last_commit_sha}
                      </span>
                    )}
                  </div>
                  {repo.last_sync_status === 'error' && repo.last_sync_message && (
                    <p className="text-xs text-red-500 dark:text-red-400 mt-1 m-0 break-all">
                      {repo.last_sync_message}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <Tooltip title={t('skillsGit.syncNow')}>
                  <Button
                    type="text"
                    size="middle"
                    icon={<CloudSyncOutlined />}
                    onClick={() => syncMutation.mutate(repo.id)}
                    loading={syncMutation.isPending && syncMutation.variables === repo.id}
                    className="text-gray-600 dark:text-gray-400 hover:text-primary-500"
                  >
                    <span className="hidden md:inline">{t('skillsGit.syncNow')}</span>
                  </Button>
                </Tooltip>
                <Tooltip title={t('skillsGit.editRepo')}>
                  <Button
                    type="text"
                    size="middle"
                    icon={<EditOutlined />}
                    onClick={() => openEdit(repo)}
                    className="text-gray-600 dark:text-gray-400 hover:text-primary-500"
                  />
                </Tooltip>
                <Popconfirm
                  title={t('skillsGit.deleteConfirmTitle', { name: repo.name })}
                  description={t('skillsGit.deleteConfirmContent')}
                  okText={t('common.delete')}
                  cancelText={t('common.cancel')}
                  okButtonProps={{ danger: true }}
                  onConfirm={() => deleteMutation.mutate(repo.id)}
                >
                  <Button
                    type="text"
                    danger
                    size="middle"
                    icon={<DeleteOutlined />}
                    className="hover:!text-red-500"
                  />
                </Popconfirm>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal
        title={
          editingRepo
            ? t('skillsGit.modalEditTitle', { name: editingRepo.name })
            : t('skillsGit.modalCreateTitle')
        }
        open={modalOpen}
        onCancel={() => {
          setModalOpen(false);
          setEditingRepo(null);
          form.resetFields();
        }}
        footer={null}
        destroyOnHidden
        width={680}
        styles={{ body: { maxHeight: '70vh', overflowY: 'auto', paddingTop: 8 } }}
      >
        <Form
          form={form}
          layout="vertical"
          initialValues={DEFAULT_FORM}
          onFinish={submitForm}
          requiredMark="optional"
        >
          {/* === 基本信息 === */}
          <Typography.Text
            type="secondary"
            strong
            className="text-xs uppercase tracking-wide"
          >
            {t('skillsGit.sectionBasic')}
          </Typography.Text>
          <Divider className="!mt-1 !mb-3" />

          <Form.Item
            name="name"
            label={t('skillsGit.fieldName')}
            rules={[{ required: true, message: t('skillsGit.nameRequired') }]}
          >
            <Input placeholder={t('skillsGit.namePlaceholder')} />
          </Form.Item>
          <Form.Item
            name="url"
            label={t('skillsGit.fieldUrl')}
            rules={[{ required: true, message: t('skillsGit.urlRequired') }]}
            tooltip={t('skillsGit.urlExtra')}
          >
            <Input
              placeholder="https://github.com/owner/repo.git"
              className="font-mono"
            />
          </Form.Item>

          {/* === 仓库内容 === */}
          <Typography.Text
            type="secondary"
            strong
            className="text-xs uppercase tracking-wide mt-4 block"
          >
            {t('skillsGit.sectionContent')}
          </Typography.Text>
          <Divider className="!mt-1 !mb-3" />

          <Form.Item name="kind" label={t('skillsGit.fieldKind')}>
            <Segmented
              block
              options={[
                {
                  label: (
                    <div className="py-1">
                      <div className="font-medium text-sm">
                        {t('skillsGit.kindSingle')}
                      </div>
                      <div className="text-[11px] opacity-70 mt-0.5">
                        {t('skillsGit.kindSingleHint')}
                      </div>
                    </div>
                  ),
                  value: 'single',
                },
                {
                  label: (
                    <div className="py-1">
                      <div className="font-medium text-sm">
                        {t('skillsGit.kindMulti')}
                      </div>
                      <div className="text-[11px] opacity-70 mt-0.5">
                        {t('skillsGit.kindMultiHint')}
                      </div>
                    </div>
                  ),
                  value: 'multi',
                },
              ]}
            />
          </Form.Item>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4">
            <Form.Item name="branch" label={t('skillsGit.fieldBranch')}>
              <Input
                placeholder={t('skillsGit.branchPlaceholder')}
                className="font-mono"
              />
            </Form.Item>
            <Form.Item
              name="target"
              label={
                watchedKind === 'multi'
                  ? t('skillsGit.fieldTargetMulti')
                  : t('skillsGit.fieldTargetSingle')
              }
              tooltip={
                watchedKind === 'multi'
                  ? t('skillsGit.targetMultiExtra')
                  : t('skillsGit.targetSingleExtra')
              }
            >
              <Input
                placeholder={watchedKind === 'multi' ? 'skills/' : 'my-skill'}
                className="font-mono"
              />
            </Form.Item>
          </div>

          {/* === 认证 === */}
          <Typography.Text
            type="secondary"
            strong
            className="text-xs uppercase tracking-wide mt-4 block"
          >
            {t('skillsGit.sectionAuth')}
          </Typography.Text>
          <Divider className="!mt-1 !mb-3" />

          <Form.Item name="authKind" className="!mb-3">
            <Segmented
              block
              options={[
                {
                  label: t('skillsGit.authNone'),
                  value: 'none',
                  icon: <SafetyOutlined />,
                },
                {
                  label: t('skillsGit.authToken'),
                  value: 'token',
                  icon: <KeyOutlined />,
                },
                {
                  label: t('skillsGit.authSsh'),
                  value: 'ssh',
                  icon: <KeyOutlined />,
                },
              ]}
            />
          </Form.Item>

          {watchedAuthKind === 'none' && (
            <div className="rounded-md border border-dashed border-gray-200 dark:border-gray-700 bg-gray-50/60 dark:bg-gray-900/30 px-3 py-2.5 mb-4 text-xs text-gray-500 dark:text-gray-400">
              {t('skillsGit.authNoneHint')}
            </div>
          )}

          {watchedAuthKind === 'token' && (
            <div className="rounded-md border border-gray-200/70 dark:border-gray-700/60 bg-gray-50/60 dark:bg-gray-900/30 px-4 pt-3 pb-1 mb-4">
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-3 m-0">
                {t('skillsGit.tokenEnvExtra')}
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4">
                <Form.Item
                  name="tokenEnv"
                  label={t('skillsGit.fieldTokenEnv')}
                  rules={[
                    {
                      required: true,
                      message: t('skillsGit.tokenEnvRequired'),
                    },
                  ]}
                >
                  <Input placeholder="GITHUB_TOKEN" className="font-mono" />
                </Form.Item>
                <Form.Item
                  name="username"
                  label={t('skillsGit.fieldUsername')}
                  tooltip={t('skillsGit.usernameExtra')}
                >
                  <Input
                    placeholder="oauth2 / x-access-token"
                    className="font-mono"
                  />
                </Form.Item>
              </div>
            </div>
          )}

          {watchedAuthKind === 'ssh' && (
            <div className="rounded-md border border-gray-200/70 dark:border-gray-700/60 bg-gray-50/60 dark:bg-gray-900/30 px-4 pt-3 pb-1 mb-4">
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-3 m-0">
                {t('skillsGit.sshKeyPathExtra')}
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4">
                <Form.Item
                  name="sshKeyPath"
                  label={t('skillsGit.fieldSshKeyPath')}
                  rules={[
                    {
                      required: true,
                      message: t('skillsGit.sshKeyRequired'),
                    },
                  ]}
                >
                  <Input
                    placeholder="~/.ssh/id_ed25519"
                    className="font-mono"
                  />
                </Form.Item>
                <Form.Item
                  name="sshPassphraseEnv"
                  label={t('skillsGit.fieldSshPassphraseEnv')}
                  tooltip={t('skillsGit.sshPassphraseEnvExtra')}
                >
                  <Input placeholder="SSH_PASSPHRASE" className="font-mono" />
                </Form.Item>
              </div>
            </div>
          )}

          {/* === 自动更新 === */}
          <Typography.Text
            type="secondary"
            strong
            className="text-xs uppercase tracking-wide mt-4 block"
          >
            {t('skillsGit.sectionSchedule')}
          </Typography.Text>
          <Divider className="!mt-1 !mb-3" />

          <div className="rounded-md border border-gray-200/70 dark:border-gray-700/60 bg-gray-50/60 dark:bg-gray-900/30 px-4 py-3 mb-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-gray-800 dark:text-gray-200">
                  {t('skillsGit.fieldAutoUpdate')}
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  {t('skillsGit.autoUpdateHint')}
                </div>
              </div>
              <Form.Item
                name="autoUpdate"
                valuePropName="checked"
                noStyle
              >
                <Switch />
              </Form.Item>
            </div>
            {watchedAutoUpdate && (
              <>
                <Divider className="!my-3" />
                <div className="flex items-center gap-3">
                  <span className="text-sm text-gray-700 dark:text-gray-300 whitespace-nowrap">
                    {t('skillsGit.fieldInterval')}
                  </span>
                  <Form.Item name="intervalMinutes" noStyle>
                    <InputNumber
                      min={5}
                      max={1440}
                      step={5}
                      className="!w-36"
                      addonAfter={t('skillsGit.minutesUnit')}
                    />
                  </Form.Item>
                  <Tooltip title={t('skillsGit.intervalExtra')}>
                    <span className="text-xs text-gray-400 dark:text-gray-500 cursor-help">
                      {t('skillsGit.intervalShortExtra')}
                    </span>
                  </Tooltip>
                </div>
              </>
            )}
          </div>

          <Form.Item className="!mb-0">
            <div className="flex justify-end gap-2">
              <Button
                onClick={() => {
                  setModalOpen(false);
                  setEditingRepo(null);
                  form.resetFields();
                }}
              >
                {t('common.cancel')}
              </Button>
              <Button type="primary" htmlType="submit" loading={submitting}>
                {t('common.save')}
              </Button>
            </div>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
