/**
 * Curated IANA time zones for the Settings dropdown (optional field).
 * For values not listed here, edit config.json or pick from the injected
 * row when the current config already uses another zone.
 */

export const COMMON_IANA_TIME_ZONES: readonly string[] = [
  'UTC',
  // East Asia & Oceania
  'Asia/Shanghai',
  'Asia/Hong_Kong',
  'Asia/Taipei',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Asia/Singapore',
  'Australia/Sydney',
  'Australia/Melbourne',
  'Pacific/Auckland',
  // Southeast & South Asia
  'Asia/Bangkok',
  'Asia/Jakarta',
  'Asia/Manila',
  'Asia/Kuala_Lumpur',
  'Asia/Ho_Chi_Minh',
  'Asia/Kolkata',
  'Asia/Dubai',
  // Americas
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Toronto',
  'America/Vancouver',
  'America/Mexico_City',
  'America/Sao_Paulo',
  'America/Argentina/Buenos_Aires',
  // Europe, Middle East, Africa
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Rome',
  'Europe/Madrid',
  'Europe/Amsterdam',
  'Europe/Moscow',
  'Asia/Jerusalem',
  'Asia/Riyadh',
  'Africa/Cairo',
  'Africa/Johannesburg',
] as const;

export function getCommonTimeZoneSelectOptions(): { label: string; value: string }[] {
  return COMMON_IANA_TIME_ZONES.map((z) => ({ label: z, value: z }));
}
