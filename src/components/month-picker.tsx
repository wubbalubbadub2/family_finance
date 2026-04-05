'use client';

import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { currentMonthAlmaty, monthNameRu } from '@/lib/utils';

export default function MonthPicker() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { year: nowYear, month: nowMonth } = currentMonthAlmaty();

  const year = parseInt(searchParams.get('year') ?? '') || nowYear;
  const month = parseInt(searchParams.get('month') ?? '') || nowMonth;

  // Max month = current month + 2 (planning ahead)
  const maxTotalMonths = nowYear * 12 + (nowMonth - 1) + 2;
  const maxYear = Math.floor(maxTotalMonths / 12);
  const maxMonth = (maxTotalMonths % 12) + 1;

  const isAtMax = year === maxYear && month === maxMonth;

  function navigate(dir: -1 | 1) {
    let newMonth = month + dir;
    let newYear = year;
    if (newMonth < 1) { newMonth = 12; newYear--; }
    if (newMonth > 12) { newMonth = 1; newYear++; }
    if (newYear > maxYear || (newYear === maxYear && newMonth > maxMonth)) return;
    router.push(`${pathname}?year=${newYear}&month=${newMonth}`);
  }

  return (
    <div className="flex items-center justify-center gap-3 py-4 px-5">
      <button
        onClick={() => navigate(-1)}
        className="w-8 h-8 flex items-center justify-center rounded-full transition-all hover:scale-105 active:scale-95"
        style={{ color: 'var(--text-tertiary)' }}
      >
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
          <path d="M11 14L6 9l5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
      <span
        className="text-[13px] font-semibold min-w-[140px] text-center tabular"
        style={{ color: 'var(--text-primary)' }}
      >
        {monthNameRu(month)} {year}
      </span>
      <button
        onClick={() => navigate(1)}
        disabled={isAtMax}
        className="w-8 h-8 flex items-center justify-center rounded-full transition-all hover:scale-105 active:scale-95 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:scale-100"
        style={{ color: 'var(--text-tertiary)' }}
      >
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
          <path d="M7 4l5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
    </div>
  );
}
