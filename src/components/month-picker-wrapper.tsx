import { Suspense } from 'react';
import MonthPicker from './month-picker';

function Skeleton() {
  return (
    <div className="flex items-center justify-between px-6 pt-4 pb-1">
      <div className="w-9 h-9" />
      <div className="h-4 w-28 rounded animate-pulse" style={{ backgroundColor: 'var(--ink-6)' }} />
      <div className="w-9 h-9" />
    </div>
  );
}

export default function MonthPickerWrapper() {
  return (
    <Suspense fallback={<Skeleton />}>
      <MonthPicker />
    </Suspense>
  );
}
