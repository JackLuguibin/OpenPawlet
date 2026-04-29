import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Card, Empty, Form, Input, Modal, Select, Space, Spin } from 'antd';
import { PlusOutlined, ReloadOutlined, RightOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useAppStore } from '../store';
import { PageLayout } from '../components/PageLayout';
import { PAGE_PRIMARY_TITLE_GRADIENT_CLASS } from '../utils/pageTitleClasses';
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
    <PageLayout variant="bleed" embedded={embedded} className="min-h-0 flex-1 overflow-hidden">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex shrink-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h1 className={PAGE_PRIMARY_TITLE_GRADIENT_CLASS}>{t('teams.title')}</h1>
            <p className="mt-1 hidden text-sm text-gray-500 sm:block dark:text-gray-400">
              {t('teams.subtitle')}
            </p>
          </div>
          <Space align="center" size="small" className="shrink-0">
            <Button
              icon={<ReloadOutlined />}
              onClick={() => refetch()}
              className="border-gray-300 dark:border-gray-600 hover:border-gray-400 dark:hover:border-gray-500"
            >
              <span className="hidden sm:inline">{t('common.refresh')}</span>
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => setCreateOpen(true)}
              className="shadow-md shadow-blue-500/25"
            >
              <span className="hidden sm:inline">{t('teams.newTeam')}</span>
            </Button>
          </Space>
        </div>

        <Card
          className="mt-4 flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-gray-200/90 shadow-sm dark:border-gray-700/80 dark:bg-gray-800/35"
          styles={{
            body: { padding: 0, display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 },
          }}
        >
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
        {isLoading ? (
          <div className="flex justify-center py-12">
            <Spin size="large" />
          </div>
        ) : teams.length === 0 ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center">
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                <span className="text-gray-500 dark:text-gray-400">{t('teams.empty')}</span>
              }
            />
            <Button
              type="primary"
              icon={<PlusOutlined />}
              className="mt-4 shadow-md shadow-blue-500/25"
              onClick={() => setCreateOpen(true)}
            >
              {t('teams.newTeam')}
            </Button>
          </div>
        ) : (
          <div className="grid w-full grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
            {teams.map((team) => (
              <Link
                key={team.id}
                to={`/teams/${encodeURIComponent(team.id)}`}
                className="group block rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-950"
              >
                <article className="relative flex h-full flex-col overflow-hidden rounded-xl border border-gray-200 bg-white p-5 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-gray-300 hover:shadow-md dark:border-gray-700 dark:bg-gray-800 dark:hover:border-gray-600">
                  <div className="flex items-start gap-4">
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 text-lg font-semibold text-white shadow-md shadow-blue-500/30">
                      {team.name.trim().charAt(0).toUpperCase() || '?'}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <h2 className="truncate text-base font-semibold text-gray-900 dark:text-gray-100">
                          {team.name}
                        </h2>
                        <RightOutlined className="mt-0.5 shrink-0 text-gray-300 opacity-0 transition-all group-hover:translate-x-0.5 group-hover:opacity-100 dark:text-gray-500" />
                      </div>
                      <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-gray-500 dark:text-gray-400">
                        {team.description || t('teams.noDescription')}
                      </p>
                      <div className="mt-4 flex flex-wrap items-center gap-2">
                        <span className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-2.5 py-0.5 text-xs font-medium text-gray-700 dark:border-gray-600 dark:bg-gray-900/60 dark:text-gray-300">
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
          </div>
        </Card>
      </div>

      <Modal
        title={t('teams.createTitle')}
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        destroyOnClose
        width={560}
        okButtonProps={{
          className: 'rounded-lg shadow-md shadow-blue-500/25',
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
            extra={<span className="text-gray-500 dark:text-gray-400">{t('teams.teamSkillsHelp')}</span>}
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
