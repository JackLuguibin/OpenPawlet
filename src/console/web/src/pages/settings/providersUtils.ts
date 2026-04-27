import type { TFunction } from 'i18next';
import i18n from '../../i18n';

/** Provider names that can be configured in Settings (schema keys, lowercase). */
export const PROVIDER_NAMES = [
  'openai',
  'anthropic',
  'openrouter',
  'deepseek',
  'ollama',
  'custom',
  'groq',
  'gemini',
  'azure_openai',
  'vllm',
  'dashscope',
  'zhipu',
  'moonshot',
  'minimax',
  'aihubmix',
  'siliconflow',
  'volcengine',
  'volcengine_coding_plan',
  'byteplus',
  'byteplus_coding_plan',
] as const;

export type ProviderName = (typeof PROVIDER_NAMES)[number];

export interface ProviderFormEntry {
  apiKey: string;
  apiBase: string;
  extraHeadersJson: string;
}

export function providerDisplayName(name: ProviderName, t: TFunction): string {
  const key = `settings.providerBrand.${name}`;
  const translated = t(key);
  if (translated !== key) return translated;
  return name
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

/** Match pydantic `to_camel` for provider field names in model_dump(by_alias=True). */
export function providerSchemaKeyToJsonKey(snake: string): string {
  const parts = snake.split('_');
  if (parts.length === 1) return parts[0].toLowerCase();
  return (
    parts[0].toLowerCase() +
    parts
      .slice(1)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
      .join('')
  );
}

export function buildProvidersPayload(
  providerForm: Record<string, ProviderFormEntry>,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const name of PROVIDER_NAMES) {
    const entry = providerForm[name] ?? { apiKey: '', apiBase: '', extraHeadersJson: '' };
    const trimmedJson = entry.extraHeadersJson?.trim() ?? '';
    let extraHeaders: Record<string, string> | null = null;
    if (trimmedJson) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmedJson) as unknown;
      } catch {
        throw new Error(i18n.t('settings.errExtraHeadersJson', { name }));
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error(i18n.t('settings.errExtraHeadersObject', { name }));
      }
      const obj = parsed as Record<string, unknown>;
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v !== 'string') {
          throw new Error(i18n.t('settings.errExtraHeadersString', { name, key: k }));
        }
      }
      extraHeaders = obj as Record<string, string>;
    }
    const jsonKey = providerSchemaKeyToJsonKey(name);
    out[jsonKey] = {
      apiKey: entry.apiKey?.trim() ?? '',
      apiBase: entry.apiBase?.trim() ? entry.apiBase.trim() : null,
      extraHeaders,
    };
  }
  return out;
}
