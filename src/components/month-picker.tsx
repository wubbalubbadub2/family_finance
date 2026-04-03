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

  const isCurrent = year === nowYear && month === nowMonth;

  function navigate(dir: -1 | 1) {
    let newMonth = month + dir;
    let newYear = year;
    if (newMonth < 1) { newMonth = 12; newYear--; }
    if (newMonth > 12) { newMonth = 1; newYear++; }
    // Don't go to future months
    if (newYear > nowYear || (newYear === nowYear && newMonth > nowMonth)) return;
    router.push(`${pathname}?year=${newYear}&month=${newMonth}`);
  }

  return (
    <div className="flex items-center justify-center gap-4 py-3">
      <button
        onClick={() => navigate(-1)}
        className="w-8 h-8 flex items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10 12L6 8l4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
      </button>
      <span className="text-sm font-semibold text-gray-700 min-w-[140px] text-center">
        {monthNameRu(month)} {year}
      </span>
      <button
        onClick={() => navigate(1)}
        disabled={isCurrent}
        className={`w-8 h-8 flex items-center justify-center rounded-full transition-colors ${
          isCurrent ? 'text-gray-200 cursor-not-allowed' : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600'
        }`}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
      </button>
    </div>
  );
}
