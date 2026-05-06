// Shared status-bucket helpers used by FamiliesTable for filtering.
// ExtendRow keeps its own (finer-grained) display labels; the buckets here
// are coarser and stable enough to drive a dropdown filter.

const DAY_MS = 24 * 60 * 60 * 1000;

export type StatusBucket = 'not-activated' | 'no-transactions' | 'active' | 'silent';
export type PayBucket = 'expired' | 'soon' | 'active' | 'unlimited';

interface FamilyLike {
  member_count: number;
  tx_count: number;
  last_tx_at: string | null;
  paid_until: string;
}

export function statusBucket(f: FamilyLike, nowMs: number): StatusBucket {
  if (f.member_count === 0) return 'not-activated';
  if (f.tx_count === 0) return 'no-transactions';
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
  'no-transactions': 'Нет транзакций',
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
