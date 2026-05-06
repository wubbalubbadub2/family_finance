// Admin dashboard: list families with paid_until status + extend buttons.
// Auth via src/middleware.ts (HTTP Basic Auth on /admin/* and /api/admin/*).
//
// Server component — fetches list, hands off to client FamiliesTable for the
// interactive filter + table render.

import { listFamiliesWithPaidStatus } from '@/lib/db/queries';
import FamiliesTable from './families-table';

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

        <FamiliesTable families={families} serverNow={now} />

        <div
          className="mt-8 p-4 rounded text-[12px]"
          style={{ backgroundColor: 'var(--ink-7)', color: 'var(--ink-3)' }}
        >
          <strong>Как работает:</strong> при первом сообщении бота создаётся
          новая семья с 3-дневным пробным периодом. Клиент платит → ты
          продлеваешь здесь. В paywall-сообщении бот показывает 6-символьный
          код (первые 6 символов family_id) — клиент присылает его вместе с
          чеком, ты вставляешь код в поиск выше. Дата 2099-01-01 = условно
          безлимит (для своих и старых клиентов).
        </div>
      </div>
    </main>
  );
}
