/**
 * ApiKeyListEditor — structured editor for an instance's `apiKeys` list.
 *
 * Two modes:
 *
 * 1. `mode="online"` (instanceId provided): every add / rename / delete /
 *    reorder hits the dedicated `/keys` sub-resource endpoint immediately
 *    so the secret never has to round-trip through the SPA's React Query
 *    cache.  The list itself is read from the cached `instance.apiKeys`
 *    masked rows.
 *
 * 2. `mode="draft"` (creating a new instance): keys are kept locally as
 *    plaintext drafts and emitted via `onDraftChange` so the parent form
 *    can include them in the create payload.
 *
 * Privacy notes:
 *
 * - Online mode only ever holds plaintext for a single key at a time
 *   (the row currently being added, edited, or revealed) and clears it
 *   on blur / collapse.
 * - The eye toggle calls `POST /keys/{id}/reveal` on demand and the
 *   plaintext is dropped from state when the row collapses or the
 *   instance editor closes.
 */

import { useEffect, useState } from 'react';
import {
  Button,
  Empty,
  Input,
  Popconfirm,
  Space,
  Tag,
  Tooltip,
  Typography,
  message as antdMessage,
} from 'antd';
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  PlusOutlined,
  SaveOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import * as api from '../../api/client';
import type { MaskedApiKey } from '../../api/types_llm_providers';
import { formatQueryError } from '../../utils/errors';
import { emptyDraftRow, type ApiKeyDraftRow } from './apiKeyDraft';

const { Text } = Typography;

interface OnlineProps {
  mode: 'online';
  botId: string;
  instanceId: string;
  keys: MaskedApiKey[];
}

interface DraftProps {
  mode: 'draft';
  drafts: ApiKeyDraftRow[];
  onDraftChange: (next: ApiKeyDraftRow[]) => void;
}

type Props = OnlineProps | DraftProps;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ApiKeyListEditor(props: Props) {
  const { t } = useTranslation();
  if (props.mode === 'online') {
    return <OnlineEditor {...props} t={t} />;
  }
  return <DraftEditor {...props} t={t} />;
}

// ---------------------------------------------------------------------------
// Online mode (existing instance)
// ---------------------------------------------------------------------------

function OnlineEditor({
  botId,
  instanceId,
  keys,
  t,
}: OnlineProps & { t: (k: string, opts?: Record<string, unknown>) => string }) {
  const queryClient = useQueryClient();
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['llm-providers', botId] });

  const [adding, setAdding] = useState(false);
  const [draftLabel, setDraftLabel] = useState('');
  const [draftValue, setDraftValue] = useState('');
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editValue, setEditValue] = useState('');

  const addMutation = useMutation({
    mutationFn: () =>
      api.addLLMProviderKey(botId, instanceId, {
        label: draftLabel.trim(),
        value: draftValue.trim(),
      }),
    onSuccess: () => {
      antdMessage.success(t('llmProviders.keyAdded'));
      setDraftLabel('');
      setDraftValue('');
      setAdding(false);
      invalidate();
    },
    onError: (err) => antdMessage.error(formatQueryError(err)),
  });

  const patchMutation = useMutation({
    mutationFn: (input: { keyId: string; label?: string; value?: string }) =>
      api.patchLLMProviderKey(botId, instanceId, input.keyId, {
        label: input.label,
        value: input.value,
      }),
    onSuccess: () => {
      antdMessage.success(t('llmProviders.keySaved'));
      setEditingId(null);
      invalidate();
    },
    onError: (err) => antdMessage.error(formatQueryError(err)),
  });

  const deleteMutation = useMutation({
    mutationFn: (keyId: string) =>
      api.deleteLLMProviderKey(botId, instanceId, keyId),
    onSuccess: () => {
      antdMessage.success(t('llmProviders.keyDeleted'));
      invalidate();
    },
    onError: (err) => antdMessage.error(formatQueryError(err)),
  });

  const reorderMutation = useMutation({
    mutationFn: (orderedIds: string[]) =>
      api.reorderLLMProviderKeys(botId, instanceId, orderedIds),
    onSuccess: () => invalidate(),
    onError: (err) => antdMessage.error(formatQueryError(err)),
  });

  const handleReveal = async (entry: MaskedApiKey) => {
    if (entry.id in revealed) {
      // Toggle off — drop the plaintext from local state.
      const next = { ...revealed };
      delete next[entry.id];
      setRevealed(next);
      return;
    }
    try {
      const result = await api.revealLLMProviderKey(botId, instanceId, entry.id);
      setRevealed({ ...revealed, [entry.id]: result.value });
    } catch (err) {
      antdMessage.error(formatQueryError(err));
    }
  };

  const handleCopy = async (entry: MaskedApiKey) => {
    try {
      const cached = revealed[entry.id];
      const value =
        cached ??
        (await api.revealLLMProviderKey(botId, instanceId, entry.id)).value;
      await navigator.clipboard.writeText(value);
      antdMessage.success(t('llmProviders.keyCopied'));
    } catch (err) {
      antdMessage.error(formatQueryError(err));
    }
  };

  const moveKey = (idx: number, dir: -1 | 1) => {
    const target = idx + dir;
    if (target < 0 || target >= keys.length) return;
    const order = keys.map((k) => k.id);
    [order[idx], order[target]] = [order[target], order[idx]];
    reorderMutation.mutate(order);
  };

  const beginEdit = (entry: MaskedApiKey) => {
    setEditingId(entry.id);
    setEditLabel(entry.label);
    setEditValue('');
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditLabel('');
    setEditValue('');
  };

  return (
    <div className="rounded-md border border-gray-200/80 bg-gray-50/40 p-2 dark:border-gray-700/60 dark:bg-gray-800/30">
      {keys.length === 0 && !adding ? (
        <div className="px-2 py-4">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <Text type="secondary" className="text-xs">
                {t('llmProviders.keysEmpty')}
              </Text>
            }
          />
        </div>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {keys.map((entry, idx) => {
            const isEditing = editingId === entry.id;
            const isRevealed = entry.id in revealed;
            return (
              <li
                key={entry.id}
                className="rounded border border-gray-200/80 bg-white px-2 py-1.5 dark:border-gray-700 dark:bg-gray-900/40"
              >
                {isEditing ? (
                  <div className="flex flex-col gap-2">
                    <Space.Compact className="w-full">
                      <Input
                        value={editLabel}
                        placeholder={t('llmProviders.keyLabelPh')}
                        onChange={(e) => setEditLabel(e.target.value)}
                        maxLength={64}
                        className="!w-32"
                      />
                      <Input.Password
                        value={editValue}
                        placeholder={t('llmProviders.keyValueRotatePh')}
                        onChange={(e) => setEditValue(e.target.value)}
                        className="font-mono"
                      />
                    </Space.Compact>
                    <div className="flex justify-end gap-1">
                      <Button size="small" onClick={cancelEdit}>
                        {t('common.cancel')}
                      </Button>
                      <Button
                        size="small"
                        type="primary"
                        icon={<SaveOutlined />}
                        loading={patchMutation.isPending}
                        onClick={() =>
                          patchMutation.mutate({
                            keyId: entry.id,
                            label: editLabel.trim(),
                            value: editValue.trim() || undefined,
                          })
                        }
                      >
                        {t('common.save')}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <div className="flex w-12 shrink-0 flex-col items-center gap-0.5 text-gray-400">
                      <Tooltip title={t('llmProviders.moveUp')}>
                        <Button
                          type="text"
                          size="small"
                          icon={<ArrowUpOutlined />}
                          disabled={idx === 0 || reorderMutation.isPending}
                          onClick={() => moveKey(idx, -1)}
                          className="!h-4 !w-4 !min-w-0 !p-0 leading-none"
                        />
                      </Tooltip>
                      <Tooltip title={t('llmProviders.moveDown')}>
                        <Button
                          type="text"
                          size="small"
                          icon={<ArrowDownOutlined />}
                          disabled={
                            idx === keys.length - 1 || reorderMutation.isPending
                          }
                          onClick={() => moveKey(idx, 1)}
                          className="!h-4 !w-4 !min-w-0 !p-0 leading-none"
                        />
                      </Tooltip>
                    </div>
                    <Tag
                      color={idx === 0 ? 'blue' : 'default'}
                      className="m-0 shrink-0"
                    >
                      #{idx + 1}
                    </Tag>
                    {entry.label ? (
                      <Tag className="m-0 shrink-0">{entry.label}</Tag>
                    ) : (
                      <Tag className="m-0 shrink-0 opacity-50">
                        {t('llmProviders.keyNoLabel')}
                      </Tag>
                    )}
                    <Text
                      className="min-w-0 flex-1 truncate font-mono text-xs text-gray-700 dark:text-gray-300"
                      title={isRevealed ? revealed[entry.id] : entry.masked}
                    >
                      {isRevealed ? revealed[entry.id] : entry.masked}
                    </Text>
                    <Text type="secondary" className="shrink-0 text-[10px]">
                      {t('llmProviders.keyLengthHint', {
                        length: entry.valueLength,
                      })}
                    </Text>
                    <Space.Compact size="small" className="shrink-0">
                      <Tooltip
                        title={
                          isRevealed
                            ? t('llmProviders.keyHide')
                            : t('llmProviders.keyReveal')
                        }
                      >
                        <Button
                          size="small"
                          icon={isRevealed ? <EyeInvisibleOutlined /> : <EyeOutlined />}
                          onClick={() => handleReveal(entry)}
                        />
                      </Tooltip>
                      <Tooltip title={t('llmProviders.keyCopy')}>
                        <Button
                          size="small"
                          icon={<CopyOutlined />}
                          onClick={() => handleCopy(entry)}
                        />
                      </Tooltip>
                      <Tooltip title={t('common.edit')}>
                        <Button
                          size="small"
                          icon={<EditOutlined />}
                          onClick={() => beginEdit(entry)}
                        />
                      </Tooltip>
                      <Popconfirm
                        title={t('llmProviders.keyConfirmDelete')}
                        okText={t('common.delete')}
                        okButtonProps={{ danger: true }}
                        cancelText={t('common.cancel')}
                        onConfirm={() => deleteMutation.mutate(entry.id)}
                      >
                        <Tooltip title={t('common.delete')}>
                          <Button size="small" danger icon={<DeleteOutlined />} />
                        </Tooltip>
                      </Popconfirm>
                    </Space.Compact>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {adding ? (
        <div className="mt-2 rounded border border-dashed border-blue-300 bg-white p-2 dark:border-blue-700 dark:bg-gray-900/40">
          <Space.Compact className="w-full">
            <Input
              value={draftLabel}
              placeholder={t('llmProviders.keyLabelPh')}
              onChange={(e) => setDraftLabel(e.target.value)}
              maxLength={64}
              className="!w-32"
            />
            <Input.Password
              value={draftValue}
              placeholder={t('llmProviders.keyValuePh')}
              onChange={(e) => setDraftValue(e.target.value)}
              className="font-mono"
              onPressEnter={() => draftValue.trim() && addMutation.mutate()}
            />
          </Space.Compact>
          <div className="mt-2 flex justify-end gap-1">
            <Button
              size="small"
              onClick={() => {
                setAdding(false);
                setDraftLabel('');
                setDraftValue('');
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button
              size="small"
              type="primary"
              icon={<PlusOutlined />}
              disabled={!draftValue.trim()}
              loading={addMutation.isPending}
              onClick={() => addMutation.mutate()}
            >
              {t('llmProviders.keyAdd')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex justify-end">
          <Button
            type="dashed"
            size="small"
            icon={<PlusOutlined />}
            onClick={() => setAdding(true)}
          >
            {t('llmProviders.keyAdd')}
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Draft mode (no instance yet)
// ---------------------------------------------------------------------------

function DraftEditor({
  drafts,
  onDraftChange,
  t,
}: DraftProps & { t: (k: string, opts?: Record<string, unknown>) => string }) {
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});

  // Drop reveal state for any rows that disappeared (e.g. removed).
  useEffect(() => {
    const liveIds = new Set(drafts.map((d) => d.tempId));
    const next: Record<string, boolean> = {};
    for (const [id, on] of Object.entries(revealed)) {
      if (liveIds.has(id)) next[id] = on;
    }
    if (Object.keys(next).length !== Object.keys(revealed).length) {
      setRevealed(next);
    }
  }, [drafts, revealed]);

  const updateRow = (tempId: string, patch: Partial<ApiKeyDraftRow>) => {
    onDraftChange(
      drafts.map((row) => (row.tempId === tempId ? { ...row, ...patch } : row)),
    );
  };

  const removeRow = (tempId: string) => {
    onDraftChange(drafts.filter((row) => row.tempId !== tempId));
  };

  const moveRow = (idx: number, dir: -1 | 1) => {
    const target = idx + dir;
    if (target < 0 || target >= drafts.length) return;
    const next = drafts.slice();
    [next[idx], next[target]] = [next[target], next[idx]];
    onDraftChange(next);
  };

  const addRow = () => {
    onDraftChange([...drafts, emptyDraftRow()]);
  };

  return (
    <div className="rounded-md border border-gray-200/80 bg-gray-50/40 p-2 dark:border-gray-700/60 dark:bg-gray-800/30">
      {drafts.length === 0 ? (
        <div className="px-2 py-4 text-center">
          <Text type="secondary" className="text-xs">
            {t('llmProviders.keysEmpty')}
          </Text>
        </div>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {drafts.map((row, idx) => {
            const isRevealed = !!revealed[row.tempId];
            return (
              <li
                key={row.tempId}
                className="rounded border border-gray-200/80 bg-white px-2 py-1.5 dark:border-gray-700 dark:bg-gray-900/40"
              >
                <div className="flex items-center gap-2">
                  <div className="flex w-12 shrink-0 flex-col items-center gap-0.5 text-gray-400">
                    <Button
                      type="text"
                      size="small"
                      icon={<ArrowUpOutlined />}
                      disabled={idx === 0}
                      onClick={() => moveRow(idx, -1)}
                      className="!h-4 !w-4 !min-w-0 !p-0 leading-none"
                    />
                    <Button
                      type="text"
                      size="small"
                      icon={<ArrowDownOutlined />}
                      disabled={idx === drafts.length - 1}
                      onClick={() => moveRow(idx, 1)}
                      className="!h-4 !w-4 !min-w-0 !p-0 leading-none"
                    />
                  </div>
                  <Tag color={idx === 0 ? 'blue' : 'default'} className="m-0 shrink-0">
                    #{idx + 1}
                  </Tag>
                  <Input
                    size="small"
                    value={row.label}
                    placeholder={t('llmProviders.keyLabelPh')}
                    onChange={(e) => updateRow(row.tempId, { label: e.target.value })}
                    maxLength={64}
                    className="!w-32 shrink-0"
                  />
                  {isRevealed ? (
                    <Input
                      size="small"
                      value={row.value}
                      placeholder={t('llmProviders.keyValuePh')}
                      onChange={(e) => updateRow(row.tempId, { value: e.target.value })}
                      className="min-w-0 flex-1 font-mono text-xs"
                    />
                  ) : (
                    <Input.Password
                      size="small"
                      value={row.value}
                      placeholder={t('llmProviders.keyValuePh')}
                      onChange={(e) => updateRow(row.tempId, { value: e.target.value })}
                      className="min-w-0 flex-1 font-mono text-xs"
                      visibilityToggle={false}
                    />
                  )}
                  <Space.Compact size="small" className="shrink-0">
                    <Tooltip
                      title={
                        isRevealed
                          ? t('llmProviders.keyHide')
                          : t('llmProviders.keyReveal')
                      }
                    >
                      <Button
                        size="small"
                        icon={isRevealed ? <EyeInvisibleOutlined /> : <EyeOutlined />}
                        onClick={() =>
                          setRevealed({ ...revealed, [row.tempId]: !isRevealed })
                        }
                      />
                    </Tooltip>
                    <Tooltip title={t('common.delete')}>
                      <Button
                        size="small"
                        danger
                        icon={<DeleteOutlined />}
                        onClick={() => removeRow(row.tempId)}
                      />
                    </Tooltip>
                  </Space.Compact>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-2 flex items-center justify-between gap-2">
        <Text type="secondary" className="text-xs">
          {t('llmProviders.keysDraftHint', {
            count: drafts.filter((d) => d.value.trim()).length,
          })}
        </Text>
        <Button
          type="dashed"
          size="small"
          icon={<PlusOutlined />}
          onClick={addRow}
        >
          {t('llmProviders.keyAdd')}
        </Button>
      </div>
    </div>
  );
}

