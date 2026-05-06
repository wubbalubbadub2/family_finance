'use client';

// Client component: renders the families table with a search-as-you-type
// filter on top. Filter matches against family name, primary member's
// first_name, @username, telegram_id, and family_id_prefix — all the
// identifiers an admin might paste in to find someone.

import { useMemo, useState } from 'react';
import type { FamilyAdminRow } from '@/lib/db/queries';
import ExtendRow from './extend-row';

interface Props {
  families: FamilyAdminRow[];
  serverNow: number;
}

function matchesQuery(f: FamilyAdminRow, q: string): boolean {
  if (!q) return true;
  const qLower = q.toLowerCase().replace(/^@/, '');
  const haystack = [
    f.name,
    f.id,
    f.primary_member?.name ?? '',
    f.primary_member?.telegram_username ?? '',
    String(f.primary_member?.telegram_id ?? ''),
  ].join(' ').toLowerCase();
  return haystack.includes(qLower);
}

export default function FamiliesTable({ families, serverNow }: Props) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(
    () => families.filter((f) => matchesQuery(f, query.trim())),
    [families, query],
  );

  return (
    <>
      <div className="mb-4">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Поиск: имя, @handle, telegram_id, или код семьи (первые 6 символов)"
          className="w-full px-3 py-2 rounded text-[13px] border"
          style={{
            backgroundColor: 'var(--bg)',
            color: 'var(--ink-1)',
            borderColor: 'var(--ink-6)',
          }}
        />
      </div>

      <p className="text-[13px] mb-4" style={{ color: 'var(--ink-3)' }}>
        {filtered.length === families.length
          ? `${families.length} ${families.length === 1 ? 'семья' : 'семей'}`
          : `${filtered.length} из ${families.length} (фильтр)`}
      </p>

      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b" style={{ borderColor: 'var(--ink-6)' }}>
              <th className="text-left py-3 pr-4 font-medium" style={{ color: 'var(--ink-3)' }}>
                Семья
              </th>
              <th className="text-left py-3 pr-4 font-medium" style={{ color: 'var(--ink-3)' }}>
                Контакты
              </th>
              <th className="text-left py-3 pr-4 font-medium" style={{ color: 'var(--ink-3)' }}>
                Создана
              </th>
              <th className="text-left py-3 pr-4 font-medium" style={{ color: 'var(--ink-3)' }}>
                Оплачено до
              </th>
              <th className="text-left py-3 pr-4 font-medium" style={{ color: 'var(--ink-3)' }}>
                Активность
              </th>
              <th className="text-left py-3 pr-4 font-medium" style={{ color: 'var(--ink-3)' }}>
                Статус
              </th>
              <th className="text-right py-3 font-medium" style={{ color: 'var(--ink-3)' }}>
                Продлить
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((f) => (
              <ExtendRow
                key={f.id}
                familyId={f.id}
                name={f.name}
                createdAt={f.created_at}
                paidUntil={f.paid_until}
                memberCount={f.member_count}
                txCount={f.tx_count}
                lastTxAt={f.last_tx_at}
                distinctDays={f.distinct_days}
                primaryMember={f.primary_member}
                serverNow={serverNow}
              />
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <p className="text-[13px] py-6 text-center" style={{ color: 'var(--ink-4)' }}>
            Ничего не найдено по запросу &laquo;{query}&raquo;
          </p>
        )}
      </div>
    </>
  );
}
