import { describe, expect, it } from 'vitest';
import { SUPPORTED_LOCALES } from './index';

describe('i18n', () => {
  it('lists supported locales', () => {
    expect(SUPPORTED_LOCALES).toEqual(expect.arrayContaining(['en', 'zh']));
  });
});
