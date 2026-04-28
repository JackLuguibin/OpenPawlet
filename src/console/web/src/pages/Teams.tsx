import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Empty, Form, Input, Modal, Select, Space, Spin } from 'antd';
import { PlusOutlined, ReloadOutlined, RightOutlined } from '@ant-design/icons';
import { TeamOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useAppStore } from '../store';
import { PageLayout } from '../components/PageLayout';
import { PAGE_PRIMARY_TITLE_CLASS } from '../utils/pageTitleClasses';
import * as api from '../api/client';
import type { TeamCreateRequest } from '../api/types_teams';

const { TextArea } = Input;

export default function Teams({ embedded = false }: { embedded?: boolean } = {}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { currentBotId, addToast } = useAppStore();
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [createTeamSkills, setCreateTeamSkills] = useState<string[]>([]);
  const [createContextNotes, setCreateContextNotes] = useState('');

  const { data: skillsList } = useQuery({
    queryKey: ['skills', currentBotId],
    queryFn: () => api.listSkills(currentBotId!),
    enabled: !!currentBotId,
  });

  const { data: teams = [], isLoading, refetch } = useQuery({
    queryKey: ['teams', currentBotId],
    queryFn: () => api.listTeams(currentBotId!),
    enabled: !!currentBotId,
  });

  useEffect(() => {
    if (createOpen) {
      setName('');
      setDescription('');
      setCreateTeamSkills([]);
      setCreateContextNotes('');
    }
  }, [createOpen]);

  const createMut = useMutation({
    mutationFn: (body: TeamCreateRequest) => api.createTeam(currentBotId!, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['teams', currentBotId] });
      addToast({ type: 'success', message: t('teams.created') });
      setCreateOpen(false);
    },
    onError: (e: Error) => addToast({ type: 'error', message: e.message }),
  });

  if (!currentBotId) {
    return (
      <PageLayout variant="bleed" embedded={embedded}>
        <Empty description={t('agents.selectBotFirst')} className="py-20" />
      </PageLayout>
    );
  }

  return (
    <PageLayout variant="bleed" embedded={embedded} className="!gap-8">
      {/* Hero */}
      <section className="relative overflow-hidden rounded-2xl border border-slate-200/90 bg-gradient-to-br from-white via-violet-50/35 to-sky-50/40 px-6 py-8 shadow-sm dark:border-slate-700/80 dark:from-slate-900 dark:via-slate-900 dark:to-violet-950/30 sm:px-8 sm:py-10">
        <div
          className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-violet-400/15 blur-3xl dark:bg-violet-500/10"
          aria-hidden
        />
        <div
          className="pointer-events-none absolute -bottom-20 -left-10 h-48 w-48 rounded-full bg-sky-400/15 blur-3xl dark:bg-sky-500/10"
          aria-hidden
        />
        <div className="relative flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-2xl space-y-2">
            <h1 className={PAGE_PRIMARY_TITLE_CLASS}>
              {t('teams.title')}
            </h1>
            <p className="text-sm leading-relaxed text-slate-600 dark:text-slate-400">
              {t('teams.subtitle')}
            </p>
          </div>
          <Space className="shrink-0">
            <Button
              size="large"
              icon={<ReloadOutlined />}
              onClick={() => refetch()}
              className="rounded-xl border-slate-200 dark:border-slate-600"
            >
              {t('common.refresh')}
            </Button>
            <Button
              type="primary"
              size="large"
              icon={<PlusOutlined />}
              onClick={() => setCreateOpen(true)}
              className="rounded-xl border-0 bg-gradient-to-r from-violet-600 to-indigo-600 shadow-md shadow-violet-500/25 hover:from-violet-500 hover:to-indigo-500"
            >
              {t('teams.newTeam')}
            </Button>
          </Space>
        </div>
      </section>

      {isLoading ? (
        <div className="flex justify-center py-24">
          <Spin size="large" />
        </div>
      ) : teams.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300/80 bg-slate-50/50 py-20 dark:border-slate-600 dark:bg-slate-900/40">
          <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500/15 to-sky-500/15 text-violet-600 dark:from-violet-500/20 dark:to-sky-500/20 dark:text-violet-300">
            <TeamOutlined style={{ fontSize: 28 }} />
          </div>
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <span className="text-slate-600 dark:text-slate-400">{t('teams.empty')}</span>
            }
          />
          <Button
            type="primary"
            icon={<PlusOutlined />}
            className="mt-6 rounded-xl border-0 bg-gradient-to-r from-violet-600 to-indigo-600"
            onClick={() => setCreateOpen(true)}
          >
            {t('teams.newTeam')}
          </Button>
        </div>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {teams.map((team) => (
            <Link
              key={team.id}
              to={`/teams/${encodeURIComponent(team.id)}`}
              className="group block outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-950 rounded-2xl"
            >
              <article className="relative flex h-full flex-col overflow-hidden rounded-2xl border border-slate-200/90 bg-white/90 p-5 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-violet-300/70 hover:shadow-lg hover:shadow-violet-500/10 dark:border-slate-700/80 dark:bg-slate-900/70 dark:hover:border-violet-500/40">
                <div
                  className="pointer-events-none absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-violet-500 via-indigo-500 to-sky-500 opacity-0 transition-opacity group-hover:opacity-100"
                  aria-hidden
                />
                <div className="flex items-start gap-4">
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-indigo-600 text-lg font-semibold text-white shadow-md shadow-violet-500/30">
                    {team.name.trim().charAt(0).toUpperCase() || '?'}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <h2 className="truncate text-base font-semibold text-slate-900 dark:text-slate-50">
                        {team.name}
                      </h2>
                      <RightOutlined className="mt-0.5 shrink-0 text-slate-300 opacity-0 transition-all group-hover:translate-x-0.5 group-hover:opacity-100 dark:text-slate-500" />
                    </div>
                    <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
                      {team.description || t('teams.noDescription')}
                    </p>
                    <div className="mt-4 flex flex-wrap items-center gap-2">
                      <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                        {t('teams.memberCount', { count: team.member_agent_ids.length })}
                      </span>
                    </div>
                  </div>
                </div>
              </article>
            </Link>
          ))}
        </div>
      )}

      <Modal
        title={t('teams.createTitle')}
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        destroyOnClose
        width={560}
        okButtonProps={{
          className:
            'rounded-lg bg-gradient-to-r from-violet-600 to-indigo-600 border-0 hover:from-violet-500 hover:to-indigo-500',
        }}
        onOk={() => {
          const n = name.trim();
          if (!n) {
            addToast({ type: 'error', message: t('teams.nameRequired') });
            return;
          }
          createMut.mutate({
            name: n,
            description: description.trim() || null,
            member_agent_ids: [],
            team_skills: createTeamSkills,
            context_notes: createContextNotes.trim() || null,
          });
        }}
        confirmLoading={createMut.isPending}
      >
        <Form layout="vertical" className="mt-2">
          <Form.Item label={t('teams.name')} required>
            <Input value={name} onChange={(e) => setName(e.target.value)} className="rounded-lg" />
          </Form.Item>
          <Form.Item label={t('teams.description')}>
            <TextArea
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="rounded-lg"
            />
          </Form.Item>
          <Form.Item label={t('teams.contextNotes')}>
            <TextArea
              rows={3}
              value={createContextNotes}
              onChange={(e) => setCreateContextNotes(e.target.value)}
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
              value={createTeamSkills}
              onChange={setCreateTeamSkills}
              allowClear
              options={(skillsList || []).map((s) => ({ value: s.name, label: s.name }))}
            />
          </Form.Item>
        </Form>
      </Modal>
    </PageLayout>
  );
}
