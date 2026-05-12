'use client';

// Client component: renders the families table with a search-as-you-type
// filter on top + click-to-sort column headers. Filter matches against family
// name, family_id_prefix, AND every member's first_name + @username +
// telegram_id (so searching a wife's @handle finds the husband's family row).

import { useMemo, useState } from 'react';
import type { FamilyAdminRow } from '@/lib/db/queries';
import ExtendRow from './extend-row';
import {
  statusBucket,
  payBucket,
  STATUS_LABELS,
  PAY_LABELS,
  type StatusBucket,
  type PayBucket,
} from './family-status';

interface Props {
  families: FamilyAdminRow[];
  serverNow: number;
}

type SortKey = 'name' | 'created_at' | 'paid_until' | 'tx_count' | 'last_tx_at';
type SortDir = 'asc' | 'desc';

// Sensible default direction when first clicking a column. paid_until=asc so
// soonest-to-expire surfaces first; created_at/last_tx_at desc so newest first.
const DEFAULT_DIR: Record<SortKey, SortDir> = {
  name: 'asc',
  created_at: 'desc',
  paid_until: 'asc',
  tx_count: 'desc',
  last_tx_at: 'desc',
};

function matchesQuery(f: FamilyAdminRow, q: string): boolean {
  if (!q) return true;
  const qLower = q.toLowerCase().replace(/^@/, '');
  const memberFields = f.members.flatMap((m) => [
    m.name,
    m.telegram_username ?? '',
    String(m.telegram_id),
  ]);
  const haystack = [f.name, f.id, ...memberFields].join(' ').toLowerCase();
  return haystack.includes(qLower);
}

function getSortValue(f: FamilyAdminRow, key: SortKey): number | string {
  switch (key) {
    case 'name': return f.name.toLowerCase();
    case 'created_at': return new Date(f.created_at).getTime();
    case 'paid_until': return new Date(f.paid_until).getTime();
    case 'tx_count': return f.tx_count;
    // null last_tx_at sorts as 0 → goes to bottom on desc, top on asc.
    case 'last_tx_at': return f.last_tx_at ? new Date(f.last_tx_at).getTime() : 0;
  }
}

interface SortHeaderProps {
  label: string;
  sortKey: SortKey;
  active: SortKey;
  dir: SortDir;
  onClick: (k: SortKey) => void;
  align?: 'left' | 'right';
}

function SortHeader({ label, sortKey, active, dir, onClick, align = 'left' }: SortHeaderProps) {
  const isActive = active === sortKey;
  const indicator = isActive ? (dir === 'asc' ? ' ↑' : ' ↓') : '';
  return (
    <th
      onClick={() => onClick(sortKey)}
      className={`${align === 'right' ? 'text-right' : 'text-left'} py-3 pr-4 font-medium select-none`}
      style={{
        color: isActive ? 'var(--ink-1)' : 'var(--ink-3)',
        cursor: 'pointer',
      }}
    >
      {label}{indicator}
    </th>
  );
}

export default function FamiliesTable({ families, serverNow }: Props) {
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusBucket | 'all'>('all');
  const [payFilter, setPayFilter] = useState<PayBucket | 'all'>('all');
  const [sortBy, setSortBy] = useState<SortKey>('created_at');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  function toggleSort(key: SortKey) {
    if (sortBy === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(key);
      setSortDir(DEFAULT_DIR[key]);
    }
  }

  const filtered = useMemo(
    () =>
      families.filter((f) => {
        if (!matchesQuery(f, query.trim())) return false;
        if (statusFilter !== 'all' && statusBucket(f, serverNow) !== statusFilter) return false;
        if (payFilter !== 'all' && payBucket(f, serverNow) !== payFilter) return false;
        return true;
      }),
    [families, query, statusFilter, payFilter, serverNow],
  );

  const isFiltered =
    query.trim().length > 0 || statusFilter !== 'all' || payFilter !== 'all';

  const sorted = useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      const va = getSortValue(a, sortBy);
      const vb = getSortValue(b, sortBy);
      let cmp = 0;
      if (typeof va === 'number' && typeof vb === 'number') cmp = va - vb;
      else cmp = String(va).localeCompare(String(vb), 'ru');
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return arr;
  }, [filtered, sortBy, sortDir]);

  const selectStyle = {
    backgroundColor: 'var(--bg)',
    color: 'var(--ink-1)',
    borderColor: 'var(--ink-6)',
  };

  return (
    <>
      <div className="mb-3">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Поиск: имя, @handle, telegram_id, или код семьи (первые 6 символов)"
          className="w-full px-3 py-2 rounded text-[13px] border"
          style={selectStyle}
        />
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as StatusBucket | 'all')}
          className="px-3 py-2 rounded text-[13px] border"
          style={selectStyle}
        >
          {(Object.keys(STATUS_LABELS) as Array<StatusBucket | 'all'>).map((k) => (
            <option key={k} value={k}>{STATUS_LABELS[k]}</option>
          ))}
        </select>
        <select
          value={payFilter}
          onChange={(e) => setPayFilter(e.target.value as PayBucket | 'all')}
          className="px-3 py-2 rounded text-[13px] border"
          style={selectStyle}
        >
          {(Object.keys(PAY_LABELS) as Array<PayBucket | 'all'>).map((k) => (
            <option key={k} value={k}>{PAY_LABELS[k]}</option>
          ))}
        </select>
        {isFiltered && (
          <button
            onClick={() => { setQuery(''); setStatusFilter('all'); setPayFilter('all'); }}
            className="px-3 py-2 rounded text-[13px] border"
            style={selectStyle}
          >
            Сбросить
          </button>
        )}
      </div>

      <p className="text-[13px] mb-4" style={{ color: 'var(--ink-3)' }}>
        {!isFiltered
          ? `${families.length} ${families.length === 1 ? 'семья' : 'семей'}`
          : `${filtered.length} из ${families.length} (фильтр)`}
      </p>

      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b" style={{ borderColor: 'var(--ink-6)' }}>
              <SortHeader label="Семья" sortKey="name" active={sortBy} dir={sortDir} onClick={toggleSort} />
              <th className="text-left py-3 pr-4 font-medium" style={{ color: 'var(--ink-3)' }}>
                Контакты
              </th>
              <SortHeader label="Создана" sortKey="created_at" active={sortBy} dir={sortDir} onClick={toggleSort} />
              <SortHeader label="Оплачено до" sortKey="paid_until" active={sortBy} dir={sortDir} onClick={toggleSort} />
              <SortHeader label="Активность" sortKey="tx_count" active={sortBy} dir={sortDir} onClick={toggleSort} />
              <SortHeader label="Статус" sortKey="last_tx_at" active={sortBy} dir={sortDir} onClick={toggleSort} />
              <th className="text-right py-3 font-medium" style={{ color: 'var(--ink-3)' }}>
                Продлить
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((f) => (
              <ExtendRow
                key={f.id}
                familyId={f.id}
                name={f.name}
                createdAt={f.created_at}
                paidUntil={f.paid_until}
                memberCount={f.member_count}
                txCount={f.tx_count}
                userMsgCount={f.user_msg_count}
                lastTxAt={f.last_tx_at}
                distinctDays={f.distinct_days}
                members={f.members}
                serverNow={serverNow}
              />
            ))}
          </tbody>
        </table>
        {sorted.length === 0 && (
          <p className="text-[13px] py-6 text-center" style={{ color: 'var(--ink-4)' }}>
            Ничего не найдено по текущему фильтру
          </p>
        )}
      </div>
    </>
  );
}
