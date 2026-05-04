import { useCallback, useMemo } from 'react';
import {
  Modal,
  Form,
  Input,
  Select,
  InputNumber,
  Tabs,
  DatePicker,
  Row,
  Col,
  Tag,
  Tooltip,
  Alert,
  Switch,
  message,
} from 'antd';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import dayjs, { type Dayjs } from 'dayjs';
import * as api from '../../api/client';
import type { CronAddRequest, CronJob, CronScheduleKind } from '../../api/types';
import {
  encodeCronMessage,
  decodeCronMessage,
  summarizeCron,
  normalizeCronSessionPolicy,
  type CronSessionPolicy,
  type CronTaskMetadata,
} from '../../utils/cronMetadata';
import { COMMON_IANA_TIME_ZONES } from '../../utils/timezones';
import { CronExpressionBuilder } from './CronExpressionBuilder';

const { TextArea } = Input;

export interface CronTaskFormModalProps {
  open: boolean;
  botId: string | null;
  /** When provided, the modal is in edit mode (save calls PUT /cron/{id}). */
  job?: CronJob | null;
  loading?: boolean;
  onCancel: () => void;
  onSubmit: (payload: CronAddRequest) => void;
}

interface FormValues {
  name: string;
  agentId?: string;
  skills?: string[];
  mcpServers?: string[];
  tools?: string[];
  sessionPolicy?: CronSessionPolicy;
  fixedSessionKey?: string;
  scheduleKind: CronScheduleKind;
  every_seconds?: number;
  cron_expr?: string;
  cron_tz?: string;
  prompt?: string;
  windowEnabled?: boolean;
  startAt?: Dayjs | null;
  endAt?: Dayjs | null;
}

const DEFAULT_VALUES: FormValues = {
  name: '',
  agentId: '',
  skills: [],
  mcpServers: [],
  tools: [],
  sessionPolicy: 'default',
  fixedSessionKey: '',
  scheduleKind: 'cron',
  every_seconds: 3600,
  cron_expr: '0 9 * * *',
  cron_tz: '',
  prompt: '',
  windowEnabled: false,
  startAt: null,
  endAt: null,
};

function formValuesFromJob(job: CronJob | null | undefined): FormValues {
  const initial: FormValues = { ...DEFAULT_VALUES };
  if (!job) return initial;

  const decoded = decodeCronMessage(job.payload?.message ?? '');
  initial.name = job.name;
  const aid = decoded.meta.agentId?.trim();
  initial.agentId = aid || '';
  initial.skills = decoded.meta.skills ?? [];
  initial.mcpServers = decoded.meta.mcpServers ?? [];
  initial.tools = decoded.meta.tools ?? [];
  initial.sessionPolicy = normalizeCronSessionPolicy(decoded.meta.sessionPolicy);
  initial.fixedSessionKey = decoded.meta.fixedSessionKey?.trim() ?? '';
  initial.prompt = decoded.prompt;
  initial.windowEnabled = Boolean(decoded.meta.startAtMs || decoded.meta.endAtMs);
  initial.startAt = decoded.meta.startAtMs ? dayjs(decoded.meta.startAtMs) : null;
  initial.endAt = decoded.meta.endAtMs ? dayjs(decoded.meta.endAtMs) : null;
  const sched = job.schedule;
  if (sched.kind === 'every' && sched.every_ms) {
    initial.scheduleKind = 'every';
    initial.every_seconds = Math.max(1, Math.round(sched.every_ms / 1000));
  } else if (sched.kind === 'cron' && sched.expr) {
    initial.scheduleKind = 'cron';
    initial.cron_expr = sched.expr;
    initial.cron_tz = sched.tz ?? '';
  } else if (sched.kind === 'at' && sched.at_ms) {
    initial.scheduleKind = 'at';
    initial.startAt = dayjs(sched.at_ms);
  }
  return initial;
}

export function CronTaskFormModal(props: CronTaskFormModalProps) {
  const { open, botId, job, loading, onCancel, onSubmit } = props;
  const { t } = useTranslation();
  const [form] = Form.useForm<FormValues>();
  const watchedFixedKey = Form.useWatch('fixedSessionKey', form);

  const { data: agents = [] } = useQuery({
    queryKey: ['cron-form-agents', botId],
    queryFn: () => (botId ? api.listAgents(botId) : Promise.resolve([])),
    enabled: open && Boolean(botId),
  });

  const { data: skills = [] } = useQuery({
    queryKey: ['cron-form-skills', botId],
    queryFn: () => api.listSkills(botId),
    enabled: open && Boolean(botId),
  });

  const { data: mcpServers = [] } = useQuery({
    queryKey: ['cron-form-mcp', botId],
    queryFn: () => api.getMCPServers(botId),
    enabled: open && Boolean(botId),
  });

  const { data: sessions = [] } = useQuery({
    queryKey: ['cron-form-sessions', botId],
    queryFn: () => (botId ? api.listSessions(botId) : Promise.resolve([])),
    enabled: open && Boolean(botId),
  });

  /** Modal + destroyOnHidden mounts Form after `open`; fill fields once the portal has mounted. */
  const applyInitialValuesAfterOpen = useCallback(() => {
    const initial = formValuesFromJob(job ?? null);
    form.resetFields();
    form.setFieldsValue(initial);
  }, [job, form]);

  const handleAfterOpenChange = useCallback(
    (opened: boolean) => {
      if (!opened) return;
      requestAnimationFrame(() => {
        applyInitialValuesAfterOpen();
      });
    },
    [applyInitialValuesAfterOpen],
  );

  const handleOk = async () => {
    try {
      const values = await form.validateFields();
      let schedule:
        | { kind: 'every'; every_ms: number }
        | { kind: 'cron'; expr: string; tz?: string }
        | { kind: 'at'; at_ms: number };

      if (values.scheduleKind === 'every') {
        if (!values.every_seconds || values.every_seconds <= 0) {
          throw new Error(t('cron.errInvalidSchedule'));
        }
        schedule = { kind: 'every', every_ms: values.every_seconds * 1000 };
      } else if (values.scheduleKind === 'cron') {
        if (!values.cron_expr) throw new Error(t('cron.errInvalidSchedule'));
        schedule = {
          kind: 'cron',
          expr: values.cron_expr.trim(),
          tz: values.cron_tz?.trim() || undefined,
        };
      } else {
        if (!values.startAt) throw new Error(t('cron.errInvalidSchedule'));
        schedule = { kind: 'at', at_ms: values.startAt.valueOf() };
      }

      const sessPol = normalizeCronSessionPolicy(values.sessionPolicy ?? 'default');
      const meta: CronTaskMetadata = {
        agentId: values.agentId?.trim() || null,
        skills: values.skills ?? [],
        mcpServers: values.mcpServers ?? [],
        tools: values.tools ?? [],
        sessionPolicy: sessPol !== 'default' ? sessPol : undefined,
        fixedSessionKey:
          sessPol === 'fixed' ? (values.fixedSessionKey?.trim() ?? null) : null,
        startAtMs:
          values.windowEnabled && values.startAt && values.scheduleKind !== 'at'
            ? values.startAt.valueOf()
            : null,
        endAtMs: values.windowEnabled && values.endAt ? values.endAt.valueOf() : null,
      };

      const message = encodeCronMessage(values.prompt ?? '', meta);

      onSubmit({
        name: values.name.trim(),
        schedule,
        message,
      });
    } catch (e: unknown) {
      if (
        e &&
        typeof e === 'object' &&
        'errorFields' in e &&
        Array.isArray((e as { errorFields?: unknown }).errorFields) &&
        (e as { errorFields: unknown[] }).errorFields.length > 0
      ) {
        message.warning(t('cron.formValidationFailed'));
        return;
      }
      message.error(e instanceof Error ? e.message : t('cron.toastError'));
    }
  };

  const skillOptions = useMemo(
    () =>
      skills.map((s) => ({
        label: s.name,
        value: s.name,
        title: s.description || s.name,
      })),
    [skills],
  );

  const mcpOptions = useMemo(
    () => mcpServers.map((m) => ({ label: m.name, value: m.name, title: m.name })),
    [mcpServers],
  );

  const tzOptions = useMemo(
    () => COMMON_IANA_TIME_ZONES.map((tz) => ({ label: tz, value: tz })),
    [],
  );

  const agentOptions = useMemo(() => {
    const opts = agents
      .filter((a) => a.enabled !== false)
      .map((a) => ({ label: a.name, value: a.id, title: a.description || a.name }));
    return [{ label: t('cron.fieldAgentNone'), value: '' }, ...opts];
  }, [agents, t]);

  const sessionOptions = useMemo(() => {
    const base = sessions.map((s) => ({
      value: s.key,
      label: s.title?.trim() ? `${s.title} (${s.key})` : s.key,
      title: s.key,
    }));
    const fk = typeof watchedFixedKey === 'string' ? watchedFixedKey.trim() : '';
    if (fk && !base.some((o) => o.value === fk)) {
      return [{ value: fk, label: fk, title: fk }, ...base];
    }
    return base;
  }, [sessions, watchedFixedKey]);

  const isEdit = !!job;

  return (
    <Modal
      title={isEdit ? t('cron.modalEditTitle') : t('cron.modalAddTitle')}
      open={open}
      afterOpenChange={handleAfterOpenChange}
      onOk={handleOk}
      onCancel={onCancel}
      confirmLoading={loading}
      okText={isEdit ? t('common.save') : t('cron.modalAddOk')}
      cancelText={t('common.cancel')}
      width={720}
      destroyOnHidden
    >
      {/* Default preserve=true: inactive Tabs panes unmount their fields; preserve=false would drop
          values set via setFieldsValue before the Schedule tab mounts (e.g. cron_expr on edit). */}
      <Form form={form} layout="vertical" initialValues={DEFAULT_VALUES} scrollToFirstError>
        <Form.Item
          name="name"
          label={t('cron.fieldName')}
          rules={[{ required: true, message: t('cron.fieldName') }]}
        >
          <Input placeholder={t('cron.fieldNamePh')} />
        </Form.Item>

        <Tabs
          defaultActiveKey="target"
          items={[
            {
              key: 'target',
              label: t('cron.tabTarget'),
              children: (
                <>
                  <Form.Item
                    name="agentId"
                    label={t('cron.fieldAgent')}
                    tooltip={t('cron.fieldAgentTip')}
                  >
                    <Select
                      allowClear
                      showSearch
                      placeholder={t('cron.fieldAgentPh')}
                      options={agentOptions}
                      optionFilterProp="label"
                    />
                  </Form.Item>

                  <Form.Item
                    name="skills"
                    label={t('cron.fieldSkills')}
                    tooltip={t('cron.fieldSkillsTip')}
                  >
                    <Select
                      mode="multiple"
                      allowClear
                      placeholder={t('cron.fieldSkillsPh')}
                      options={skillOptions}
                      optionFilterProp="label"
                      maxTagCount="responsive"
                    />
                  </Form.Item>

                  <Form.Item
                    name="mcpServers"
                    label={t('cron.fieldMcpServers')}
                    tooltip={t('cron.fieldMcpServersTip')}
                  >
                    <Select
                      mode="multiple"
                      allowClear
                      placeholder={t('cron.fieldMcpServersPh')}
                      options={mcpOptions}
                      optionFilterProp="label"
                      maxTagCount="responsive"
                    />
                  </Form.Item>

                  <Form.Item
                    name="tools"
                    label={t('cron.fieldTools')}
                    tooltip={t('cron.fieldToolsTip')}
                  >
                    <Select
                      mode="tags"
                      allowClear
                      placeholder={t('cron.fieldToolsPh')}
                      tokenSeparators={[',', ' ']}
                      maxTagCount="responsive"
                    />
                  </Form.Item>

                  <Form.Item
                    name="sessionPolicy"
                    label={t('cron.fieldSessionPolicy')}
                    tooltip={t('cron.fieldSessionPolicyTip')}
                  >
                    <Select
                      options={[
                        { value: 'default', label: t('cron.sessionPolicy.default') },
                        { value: 'new', label: t('cron.sessionPolicy.new') },
                        { value: 'fixed', label: t('cron.sessionPolicy.fixed') },
                        { value: 'latest', label: t('cron.sessionPolicy.latest') },
                        { value: 'all', label: t('cron.sessionPolicy.all') },
                      ]}
                    />
                  </Form.Item>
                  <Form.Item
                    noStyle
                    dependencies={['sessionPolicy']}
                  >
                    {() =>
                      normalizeCronSessionPolicy(form.getFieldValue('sessionPolicy')) === 'fixed' ? (
                        <Form.Item
                          name="fixedSessionKey"
                          label={t('cron.fieldFixedSession')}
                          tooltip={t('cron.fieldFixedSessionTip')}
                          rules={[
                            {
                              required: true,
                              message: t('cron.fixedSessionRequired'),
                            },
                          ]}
                        >
                          <Select
                            showSearch
                            allowClear
                            placeholder={t('cron.fieldFixedSessionPh')}
                            options={sessionOptions}
                            optionFilterProp="label"
                          />
                        </Form.Item>
                      ) : null
                    }
                  </Form.Item>

                  <Form.Item
                    name="prompt"
                    label={t('cron.fieldPrompt')}
                    tooltip={t('cron.fieldPromptTip')}
                    rules={[
                      { required: true, message: t('cron.fieldPromptRequired') },
                    ]}
                  >
                    <TextArea rows={5} placeholder={t('cron.fieldPromptPh')} />
                  </Form.Item>
                </>
              ),
            },
            {
              key: 'schedule',
              label: t('cron.tabSchedule'),
              children: (
                <>
                  <Form.Item name="scheduleKind" label={t('cron.fieldScheduleKind')}>
                    <Select
                      options={[
                        { value: 'cron', label: t('cron.scheduleCron') },
                        { value: 'every', label: t('cron.scheduleEvery') },
                        { value: 'at', label: t('cron.scheduleAt') },
                      ]}
                    />
                  </Form.Item>
                  <Form.Item
                    noStyle
                    shouldUpdate={(prev, curr) => prev.scheduleKind !== curr.scheduleKind}
                  >
                    {({ getFieldValue }) => {
                      const kind: CronScheduleKind = getFieldValue('scheduleKind');
                      if (kind === 'every') {
                        return (
                          <Form.Item
                            name="every_seconds"
                            label={t('cron.fieldEverySeconds')}
                            rules={[{ required: true }]}
                          >
                            <InputNumber
                              min={1}
                              placeholder={t('cron.fieldEverySecondsPh')}
                              className="w-full"
                            />
                          </Form.Item>
                        );
                      }
                      if (kind === 'cron') {
                        return (
                          <>
                            <Form.Item
                              name="cron_expr"
                              label={t('cron.fieldCronExpr')}
                              rules={[{ required: true }]}
                            >
                              <Input placeholder={t('cron.fieldCronExprPh')} />
                            </Form.Item>
                            <Form.Item
                              shouldUpdate={(prev, curr) => prev.cron_expr !== curr.cron_expr}
                              noStyle
                            >
                              {({ getFieldValue: g, setFieldValue }) => (
                                <CronExpressionBuilder
                                  value={g('cron_expr') || ''}
                                  onChange={(expr) => setFieldValue('cron_expr', expr)}
                                />
                              )}
                            </Form.Item>
                            <Form.Item
                              shouldUpdate={(prev, curr) => prev.cron_expr !== curr.cron_expr}
                              noStyle
                            >
                              {({ getFieldValue: g }) => {
                                const expr: string = g('cron_expr') || '';
                                const summary = summarizeCron(expr, t);
                                return summary ? (
                                  <Alert
                                    type="info"
                                    showIcon
                                    className="mb-3"
                                    title={summary}
                                  />
                                ) : null;
                              }}
                            </Form.Item>
                            <Form.Item name="cron_tz" label={t('cron.fieldCronTz')}>
                              <Select
                                allowClear
                                showSearch
                                placeholder={t('cron.fieldCronTzPh')}
                                options={tzOptions}
                              />
                            </Form.Item>
                          </>
                        );
                      }
                      return (
                        <Form.Item
                          name="startAt"
                          label={t('cron.fieldRunAt')}
                          rules={[{ required: true }]}
                        >
                          <DatePicker
                            showTime
                            className="w-full"
                            placeholder={t('cron.fieldRunAtPh')}
                          />
                        </Form.Item>
                      );
                    }}
                  </Form.Item>
                </>
              ),
            },
            {
              key: 'window',
              label: t('cron.tabWindow'),
              children: (
                <>
                  <Form.Item
                    name="windowEnabled"
                    label={t('cron.fieldWindowEnabled')}
                    tooltip={t('cron.fieldWindowEnabledTip')}
                    valuePropName="checked"
                  >
                    <Switch />
                  </Form.Item>
                  <Form.Item
                    noStyle
                    shouldUpdate={(prev, curr) =>
                      prev.windowEnabled !== curr.windowEnabled ||
                      prev.scheduleKind !== curr.scheduleKind
                    }
                  >
                    {({ getFieldValue }) => {
                      const enabled = getFieldValue('windowEnabled');
                      const kind: CronScheduleKind = getFieldValue('scheduleKind');
                      if (!enabled) return null;
                      return (
                        <Row gutter={12}>
                          <Col span={12}>
                            <Form.Item
                              name="startAt"
                              label={t('cron.fieldStartAt')}
                              tooltip={
                                kind === 'at' ? t('cron.fieldStartAtAtTip') : undefined
                              }
                            >
                              <DatePicker
                                showTime
                                className="w-full"
                                placeholder={t('cron.fieldStartAtPh')}
                                disabled={kind === 'at'}
                              />
                            </Form.Item>
                          </Col>
                          <Col span={12}>
                            <Form.Item name="endAt" label={t('cron.fieldEndAt')}>
                              <DatePicker
                                showTime
                                className="w-full"
                                placeholder={t('cron.fieldEndAtPh')}
                              />
                            </Form.Item>
                          </Col>
                        </Row>
                      );
                    }}
                  </Form.Item>
                  <Alert
                    type="warning"
                    showIcon
                    className="mt-2"
                    title={t('cron.windowNote')}
                  />
                </>
              ),
            },
          ]}
        />

        <div className="mt-3 flex flex-wrap gap-1">
          <Tooltip title={t('cron.scheduleSummaryTip')}>
            <Tag color="blue">{t('cron.scheduleSummaryLabel')}</Tag>
          </Tooltip>
          <Form.Item
            shouldUpdate={(prev, curr) =>
              prev.scheduleKind !== curr.scheduleKind ||
              prev.cron_expr !== curr.cron_expr ||
              prev.every_seconds !== curr.every_seconds ||
              prev.startAt !== curr.startAt
            }
            noStyle
          >
            {({ getFieldValue }) => {
              const kind: CronScheduleKind = getFieldValue('scheduleKind');
              if (kind === 'cron') return <span>{getFieldValue('cron_expr') || '—'}</span>;
              if (kind === 'every')
                return <span>{t('cron.everySeconds', { count: getFieldValue('every_seconds') || 0 })}</span>;
              const at: Dayjs | null = getFieldValue('startAt');
              return <span>{at ? at.format('YYYY-MM-DD HH:mm:ss') : '—'}</span>;
            }}
          </Form.Item>
        </div>
      </Form>
    </Modal>
  );
}

export default CronTaskFormModal;
