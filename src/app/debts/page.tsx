import { formatTenge } from '@/lib/utils';
import { getActiveDebts } from '@/lib/db/queries';
import { DEFAULT_FAMILY_ID } from '@/lib/constants';
import DebtList from '@/components/debt-list';


export const dynamic = 'force-dynamic';

export default async function DebtsPage() {
  let debts: { id: string; name: string; original_amount: number; remaining_amount: number }[] = [];
  try { debts = await getActiveDebts(DEFAULT_FAMILY_ID); } catch { /* table may not exist */ }

  const totalRemaining = debts.reduce((s, d) => s + d.remaining_amount, 0);
  const totalOriginal = debts.reduce((s, d) => s + d.original_amount, 0);
  const paidOff = totalOriginal - totalRemaining;
  const pct = totalOriginal > 0 ? Math.round((paidOff / totalOriginal) * 100) : 0;

  return (
    <main className="min-h-screen pb-20" style={{ backgroundColor: 'var(--bg)' }}>
      <div className="max-w-lg mx-auto">

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
              <div className="mt-3 w-full h-[3px] overflow-hidden" style={{ backgroundColor: 'var(--ink-6)' }}>
                <div className="h-full transition-all duration-700" style={{ width: `${pct}%`, backgroundColor: 'var(--green)' }} />
              </div>
            </>
          ) : (
            <h1 className="display text-[36px]" style={{ color: 'var(--green)' }}>0 ₸</h1>
          )}
        </header>

        {debts.length === 0 ? (
          <div className="text-center py-12 px-8">
            <p className="text-[28px] mb-3">🎉</p>
            <p className="text-[14px] font-medium" style={{ color: 'var(--green)' }}>Нет активных долгов!</p>
            <p className="text-[13px] mt-2" style={{ color: 'var(--ink-4)' }}>
              Если возьмёте в долг, напишите в бот:<br />
              <span className="font-semibold" style={{ color: 'var(--ink-2)' }}>взял в долг 100000 Имя</span>
            </p>
          </div>
        ) : (
          <DebtList initialDebts={debts} />
        )}
      </div>
    </main>
  );
}
