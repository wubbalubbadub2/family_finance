export default function Loading() {
  return (
    <main className="min-h-screen pb-20 animate-pulse" style={{ backgroundColor: 'var(--bg)' }}>
      <div className="max-w-lg mx-auto">
        {/* Month picker placeholder */}
        <div className="flex items-center justify-between px-6 pt-4 pb-1">
          <div className="w-9 h-9" />
          <div className="h-4 w-28 rounded" style={{ backgroundColor: 'var(--ink-6)' }} />
          <div className="w-9 h-9" />
        </div>
        {/* Content skeleton */}
        <div className="px-6 pt-4">
          <div className="h-3 w-16 rounded mb-2" style={{ backgroundColor: 'var(--ink-6)' }} />
          <div className="h-9 w-36 rounded mb-6" style={{ backgroundColor: 'var(--ink-6)' }} />
          <div className="space-y-3">
            <div className="h-11 rounded" style={{ backgroundColor: 'var(--ink-6)' }} />
            <div className="h-11 rounded" style={{ backgroundColor: 'var(--ink-6)' }} />
            <div className="h-11 rounded" style={{ backgroundColor: 'var(--ink-6)' }} />
            <div className="h-11 rounded" style={{ backgroundColor: 'var(--ink-6)' }} />
          </div>
        </div>
      </div>
    </main>
  );
}
