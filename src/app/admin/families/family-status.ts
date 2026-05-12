// Shared status-bucket helpers used by FamiliesTable for filtering.
// ExtendRow keeps its own (finer-grained) display labels; the buckets here
// are coarser and stable enough to drive a dropdown filter.

const DAY_MS = 24 * 60 * 60 * 1000;

// Triage buckets, narrow → broad:
//   not-activated : bot is in the chat, no users joined the family record yet.
//   never-typed   : user(s) joined but have not sent a single message. True ghosts.
//   typed-no-log  : user(s) sent ≥1 message but never produced a transaction
//                   (asked questions, hit help, gave up). The actionable cohort
//                   for retention work — they ARE engaged, they just didn't log.
//   active        : last tx within 7 days.
//   silent        : last tx >7 days ago — was active, went quiet.
export type StatusBucket = 'not-activated' | 'never-typed' | 'typed-no-log' | 'active' | 'silent';
export type PayBucket = 'expired' | 'soon' | 'active' | 'unlimited';

interface FamilyLike {
  member_count: number;
  tx_count: number;
  user_msg_count: number;
  last_tx_at: string | null;
  paid_until: string;
}

export function statusBucket(f: FamilyLike, nowMs: number): StatusBucket {
  if (f.member_count === 0) return 'not-activated';
  if (f.tx_count === 0) {
    return f.user_msg_count === 0 ? 'never-typed' : 'typed-no-log';
  }
  const daysSince = f.last_tx_at
    ? Math.floor((nowMs - new Date(f.last_tx_at).getTime()) / DAY_MS)
    : Infinity;
  return daysSince <= 7 ? 'active' : 'silent';
}

export function payBucket(f: FamilyLike, nowMs: number): PayBucket {
  const exp = new Date(f.paid_until).getTime();
  const days = Math.floor((exp - nowMs) / DAY_MS);
  // 2099-prefixed dates or anything beyond a year are treated as "unlimited"
  // (the dashboard renders these as ∞).
  if (f.paid_until.startsWith('2099') || days > 365) return 'unlimited';
  if (days <= 0) return 'expired';
  if (days <= 3) return 'soon';
  return 'active';
}

export const STATUS_LABELS: Record<StatusBucket | 'all', string> = {
  all: 'Все статусы',
  'not-activated': 'Не активирован',
  'never-typed': 'Нет транзакций',         // truly silent — joined, never sent a message
  'typed-no-log': 'Пробует',                // engaged but didn't log a tx yet
  active: 'Активные (≤7д)',
  silent: 'Молчат (>7д)',
};

export const PAY_LABELS: Record<PayBucket | 'all', string> = {
  all: 'Все оплаты',
  expired: 'Истекла',
  soon: 'Истекает скоро (≤3д)',
  active: 'Оплачена',
  unlimited: '∞',
};
