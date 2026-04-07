export default function Loading() {
  return (
    <main className="min-h-screen pb-20 animate-pulse" style={{ backgroundColor: 'var(--bg)' }}>
      <div className="max-w-lg mx-auto px-6 pt-12">
        <div className="h-3 w-20 rounded" style={{ backgroundColor: 'var(--ink-6)' }} />
        <div className="h-10 w-40 rounded mt-2" style={{ backgroundColor: 'var(--ink-6)' }} />
        <div className="mt-8 space-y-4">
          <div className="h-12 rounded" style={{ backgroundColor: 'var(--ink-6)' }} />
          <div className="h-12 rounded" style={{ backgroundColor: 'var(--ink-6)' }} />
          <div className="h-12 rounded" style={{ backgroundColor: 'var(--ink-6)' }} />
        </div>
      </div>
    </main>
  );
}
