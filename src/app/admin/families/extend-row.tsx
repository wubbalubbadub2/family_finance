'use client';

// Client component for one row in the admin families table.
// - Renders absolute paid_until date (avoids stale "X days left" badge if the
//   page is open across midnight).
// - Computes daysLeft client-side from the ISO string for the colored badge.
// - +30 / +90 / custom buttons compute an absolute date from the current
//   paid_until and POST it. API takes absolute ISO so double-click = idempotent.
// - Shows primary member's first_name + @handle + tg_id so admin can match a
//   Kaspi receipt's sender to the family row in <5 seconds.

import { useState } from 'react';

interface PrimaryMember {
  name: string;
  telegram_id: number;
  telegram_username: string | null;
}

interface Props {
  familyId: string;
  name: string;
  createdAt: string;
  paidUntil: string;
  memberCount: number;
  txCount: number;
  lastTxAt: string | null;
  distinctDays: number;
  primaryMember: PrimaryMember | null;
  serverNow: number; // ms; passed from server to avoid hydration mismatch
}

const DAY_MS = 24 * 60 * 60 * 1000;

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('ru-RU', { year: 'numeric', month: 'short', day: 'numeric' });
}

function daysLeft(iso: string, fromMs: number): number {
  return Math.floor((new Date(iso).getTime() - fromMs) / DAY_MS);
}

export default function ExtendRow({
  familyId,
  name,
  createdAt,
  paidUntil,
  memberCount,
  txCount,
  lastTxAt,
  distinctDays,
  primaryMember,
  serverNow,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const days = daysLeft(paidUntil, serverNow);
  const unlimited = paidUntil.startsWith('2099') || days > 365;

  let badgeColor = 'var(--ink-2)';
  if (!unlimited) {
    if (days <= 0) badgeColor = '#c33';
    else if (days <= 3) badgeColor = '#d68a00';
    else badgeColor = '#2a7';
  }

  // Activity status: classifies the family for at-a-glance triage.
  const daysSinceLastTx = lastTxAt
    ? Math.floor((serverNow - new Date(lastTxAt).getTime()) / DAY_MS)
    : null;
  let status: { label: string; color: string };
  if (memberCount === 0) {
    status = { label: 'не активирован', color: 'var(--ink-4)' };
  } else if (txCount === 0) {
    status = { label: 'нет транзакций', color: '#d68a00' };
  } else if (daysSinceLastTx !== null && daysSinceLastTx <= 1) {
    status = { label: 'активен', color: '#2a7' };
  } else if (daysSinceLastTx !== null && daysSinceLastTx <= 7) {
    status = { label: `${daysSinceLastTx}д назад`, color: 'var(--ink-2)' };
  } else {
    status = { label: `молчит ${daysSinceLastTx}д`, color: '#c33' };
  }

  async function extend(deltaDays: number | 'custom') {
    let target: Date;
    if (deltaDays === 'custom') {
      const input = window.prompt(
        `Новая дата окончания подписки для "${name}" (YYYY-MM-DD):`,
        paidUntil.slice(0, 10),
      );
      if (!input) return;
      target = new Date(`${input}T23:59:59Z`);
      if (isNaN(target.getTime())) {
        setErr('неверная дата');
        return;
      }
    } else {
      // Client computes target from the currently displayed paid_until (closure
      // value), which doesn't change until reload. Two POSTs from the same
      // page send the same absolute date = same result. The API is idempotent
      // against the same target ISO arriving twice.
      const base = Math.max(serverNow, new Date(paidUntil).getTime());
      target = new Date(base + deltaDays * DAY_MS);
    }

    setBusy(true);
    setErr(null);
    try {
      const res = await fetch('/api/admin/extend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ familyId, paidUntil: target.toISOString() }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`${res.status}: ${body || 'failed'}`);
      }
      window.location.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <tr className="border-b" style={{ borderColor: 'var(--ink-6)' }}>
      <td className="py-3 pr-4">
        <div style={{ color: 'var(--ink-1)' }}>{name}</div>
        <div className="text-[11px] mt-0.5" style={{ color: 'var(--ink-4)' }}>
          {familyId.slice(0, 6).toUpperCase()}
        </div>
      </td>
      <td className="py-3 pr-4">
        {primaryMember ? (
          <>
            <div style={{ color: 'var(--ink-1)' }}>
              {primaryMember.name}
              {memberCount > 1 && (
                <span className="text-[11px] ml-1" style={{ color: 'var(--ink-4)' }}>
                  +{memberCount - 1}
                </span>
              )}
            </div>
            <div className="text-[11px] mt-0.5" style={{ color: 'var(--ink-3)' }}>
              {primaryMember.telegram_username
                ? `@${primaryMember.telegram_username} · ${primaryMember.telegram_id}`
                : `${primaryMember.telegram_id}`}
            </div>
          </>
        ) : (
          <span style={{ color: 'var(--ink-4)' }}>—</span>
        )}
      </td>
      <td className="py-3 pr-4" style={{ color: 'var(--ink-2)' }}>
        {formatDate(createdAt)}
      </td>
      <td className="py-3 pr-4">
        <div style={{ color: 'var(--ink-1)' }}>
          {unlimited ? '∞' : formatDate(paidUntil)}
        </div>
        {!unlimited && (
          <div className="text-[11px] mt-0.5" style={{ color: badgeColor }}>
            {days <= 0 ? `истекла ${-days} дн. назад` : `осталось ${days} дн.`}
          </div>
        )}
      </td>
      <td className="py-3 pr-4" style={{ color: 'var(--ink-2)' }}>
        {txCount > 0 ? (
          <>
            <div>{txCount} тр.</div>
            <div className="text-[11px] mt-0.5" style={{ color: 'var(--ink-4)' }}>
              {distinctDays} акт. дн.
            </div>
          </>
        ) : (
          <span style={{ color: 'var(--ink-4)' }}>—</span>
        )}
      </td>
      <td className="py-3 pr-4">
        <div style={{ color: status.color }}>{status.label}</div>
        {lastTxAt && (
          <div className="text-[11px] mt-0.5" style={{ color: 'var(--ink-4)' }}>
            {formatDate(lastTxAt)}
          </div>
        )}
      </td>
      <td className="py-3 text-right">
        <div className="flex justify-end gap-2 flex-wrap">
          <button
            disabled={busy}
            onClick={() => extend(30)}
            className="px-3 py-1 rounded text-[12px] disabled:opacity-50"
            style={{ backgroundColor: 'var(--ink-7)', color: 'var(--ink-1)' }}
          >
            +30д
          </button>
          <button
            disabled={busy}
            onClick={() => extend(90)}
            className="px-3 py-1 rounded text-[12px] disabled:opacity-50"
            style={{ backgroundColor: 'var(--ink-7)', color: 'var(--ink-1)' }}
          >
            +90д
          </button>
          <button
            disabled={busy}
            onClick={() => extend('custom')}
            className="px-3 py-1 rounded text-[12px] disabled:opacity-50"
            style={{ backgroundColor: 'var(--ink-7)', color: 'var(--ink-1)' }}
          >
            Дата…
          </button>
        </div>
        {err && (
          <div className="text-[11px] mt-1" style={{ color: '#c33' }}>
            {err}
          </div>
        )}
      </td>
    </tr>
  );
}
