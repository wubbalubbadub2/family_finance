// Multi-tenancy constants.
//
// DEFAULT_FAMILY_ID: the fixed UUID used by migration 005 to backfill existing
// single-tenant data. Web pages (no auth), cron routes, and other admin paths
// operate on this family ID. The bot resolves family_id dynamically from the
// Telegram user ID, so paying-customer families are never constrained by this.
//
// Override via DEFAULT_FAMILY_ID env var if needed (e.g., for testing).
export const DEFAULT_FAMILY_ID =
  process.env.DEFAULT_FAMILY_ID ?? '00000000-0000-0000-0000-000000000001';

// Almaty timezone, used for all date math (cron schedules run in UTC on Vercel;
// we convert to Almaty for week/month boundaries and on-schedule goal math).
export const ALMATY_TZ = 'Asia/Almaty';
