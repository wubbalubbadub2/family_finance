import { Suspense } from 'react';
import { formatTenge } from '@/lib/utils';
import { getActiveDebts } from '@/lib/db/queries';
import Nav from '@/components/nav';

export const dynamic = 'force-dynamic';

function Bar({ percentage }: { percentage: number }) {
  return (
    <div className="w-full h-[3px] overflow-hidden" style={{ backgroundColor: 'var(--ink-6)' }}>
      <div
        className="h-full transition-all duration-700"
        style={{ width: `${Math.min(percentage, 100)}%`, backgroundColor: 'var(--green)' }}
      />
    </div>
  );
}

export default async function DebtsPage() {
  let debts: { id: string; name: string; original_amount: number; remaining_amount: number; created_at: string; paid_off_at: string | null }[] = [];
  try { debts = await getActiveDebts(); } catch { /* table may not exist */ }

  const totalRemaining = debts.reduce((s, d) => s + d.remaining_amount, 0);
  const totalOriginal = debts.reduce((s, d) => s + d.original_amount, 0);
  const paidOff = totalOriginal - totalRemaining;
  const pct = totalOriginal > 0 ? Math.round((paidOff / totalOriginal) * 100) : 0;

  return (
    <main className="min-h-screen pb-20" style={{ backgroundColor: 'var(--bg)' }}>
      <div className="max-w-lg mx-auto">

        {/* Header */}
        <header className="px-6 pt-8 pb-6">
          <p className="label-sm mb-1">Долги</p>
          {debts.length > 0 ? (
            <>
              <h1 className="display text-[36px]" style={{ color: 'var(--red)' }}>
                {formatTenge(totalRemaining)}
              </h1>
              <p className="text-[13px] mt-2" style={{ color: 'var(--ink-3)' }}>
                погашено {formatTenge(paidOff)} из {formatTenge(totalOriginal)} ({pct}%)
              </p>
              <div className="mt-3">
                <Bar percentage={pct} />
              </div>
            </>
          ) : (
            <h1 className="display text-[36px]" style={{ color: 'var(--green)' }}>
              0 ₸
            </h1>
          )}
        </header>

        {/* Debt list */}
        {debts.length === 0 ? (
          <div className="text-center py-12 px-8">
            <p className="text-[28px] mb-3">🎉</p>
            <p className="text-[14px] font-medium" style={{ color: 'var(--green)' }}>
              Нет активных долгов!
            </p>
            <p className="text-[13px] mt-2" style={{ color: 'var(--ink-4)' }}>
              Если возьмёте в долг, напишите в бот:<br />
              <span className="font-semibold" style={{ color: 'var(--ink-2)' }}>взял в долг 100000 Дудар</span>
            </p>
          </div>
        ) : (
          <div>
            {debts.map((d, idx) => {
              const dPaid = d.original_amount - d.remaining_amount;
              const dPct = d.original_amount > 0 ? Math.round((dPaid / d.original_amount) * 100) : 0;
              return (
                <div
                  key={d.id}
                  className="px-6 py-4"
                  style={{ borderBottom: idx === debts.length - 1 ? 'none' : '1px solid var(--ink-6)' }}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[14px] font-medium capitalize" style={{ color: 'var(--ink-1)' }}>
                      {d.name}
                    </span>
                    <span className="text-[14px] font-semibold tabular" style={{ color: 'var(--ink-1)' }}>
                      {formatTenge(d.remaining_amount)}
                    </span>
                  </div>
                  <Bar percentage={dPct} />
                  <div className="flex items-center justify-between mt-1.5">
                    <span className="text-[11px]" style={{ color: 'var(--ink-4)' }}>
                      выплачено {formatTenge(dPaid)}
                    </span>
                    <span className="text-[11px] font-medium tabular" style={{ color: dPct > 0 ? 'var(--green)' : 'var(--ink-4)' }}>
                      {dPct}%
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <Suspense><Nav /></Suspense>
    </main>
  );
}
