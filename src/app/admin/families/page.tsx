// Admin dashboard: list families with paid_until status + extend buttons.
// Auth via src/middleware.ts (HTTP Basic Auth on /admin/* and /api/admin/*).
//
// Server component — fetches list, renders table. Each row's action UI is a
// client component (extend-row.tsx) so date math + buttons stay interactive.

import { listFamiliesWithPaidStatus } from '@/lib/db/queries';
import ExtendRow from './extend-row';

export const dynamic = 'force-dynamic';

export default async function AdminFamiliesPage() {
  const families = await listFamiliesWithPaidStatus();
  const now = Date.now();

  return (
    <main className="min-h-screen p-6 pb-20" style={{ backgroundColor: 'var(--bg)' }}>
      <div className="max-w-5xl mx-auto">
        <h1 className="text-2xl font-semibold mb-6" style={{ color: 'var(--ink-1)' }}>
          /admin/families
        </h1>
        <p className="text-[13px] mb-6" style={{ color: 'var(--ink-3)' }}>
          {families.length} {families.length === 1 ? 'семья' : 'семей'} · отсортировано по дате
          создания
        </p>

        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b" style={{ borderColor: 'var(--ink-6)' }}>
                <th className="text-left py-3 pr-4 font-medium" style={{ color: 'var(--ink-3)' }}>
                  Семья
                </th>
                <th className="text-left py-3 pr-4 font-medium" style={{ color: 'var(--ink-3)' }}>
                  Создана
                </th>
                <th className="text-left py-3 pr-4 font-medium" style={{ color: 'var(--ink-3)' }}>
                  Оплачено до
                </th>
                <th className="text-left py-3 pr-4 font-medium" style={{ color: 'var(--ink-3)' }}>
                  Участники
                </th>
                <th className="text-right py-3 font-medium" style={{ color: 'var(--ink-3)' }}>
                  Продлить
                </th>
              </tr>
            </thead>
            <tbody>
              {families.map((f) => (
                <ExtendRow
                  key={f.id}
                  familyId={f.id}
                  name={f.name}
                  createdAt={f.created_at}
                  paidUntil={f.paid_until}
                  memberCount={f.member_count}
                  serverNow={now}
                />
              ))}
            </tbody>
          </table>
        </div>

        <div
          className="mt-8 p-4 rounded text-[12px]"
          style={{ backgroundColor: 'var(--ink-7)', color: 'var(--ink-3)' }}
        >
          <strong>Как работает:</strong> при создании новой семьи через invite-link
          выдаётся 3-дневный пробный период. Клиент платит → ты продлеваешь
          здесь. Дата 2099-01-01 = условно безлимит (для своих и старых клиентов).
        </div>
      </div>
    </main>
  );
}
