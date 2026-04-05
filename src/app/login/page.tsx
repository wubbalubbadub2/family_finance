'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
  const router = useRouter();
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Ошибка входа');
        setLoading(false);
        return;
      }
      router.push('/');
      router.refresh();
    } catch {
      setError('Ошибка соединения');
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen bg-white flex flex-col items-center justify-center px-6">
      <div className="w-full max-w-xs">
        <div className="text-center mb-8">
          <div className="text-4xl mb-3">💰</div>
          <h1 className="text-xl font-bold text-gray-900">Семейный бюджет</h1>
          <p className="text-sm text-gray-400 mt-1">Введите PIN-код</p>
        </div>

        <form onSubmit={handleSubmit}>
          <input
            type="password"
            inputMode="numeric"
            pattern="[0-9]*"
            autoFocus
            value={pin}
            onChange={(e) => { setPin(e.target.value); setError(''); }}
            placeholder="••••"
            maxLength={8}
            className="w-full text-center text-2xl font-semibold tracking-widest bg-gray-50 border border-gray-200 rounded-xl px-4 py-4 focus:outline-none focus:ring-2 focus:ring-gray-900 focus:border-transparent transition-all placeholder:text-gray-300"
          />

          {error && (
            <p className="text-center text-sm text-red-500 mt-3">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading || pin.length < 4}
            className="w-full mt-4 py-3.5 rounded-xl text-sm font-semibold bg-gray-900 text-white hover:bg-gray-800 active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            {loading ? 'Вход...' : 'Войти'}
          </button>
        </form>
      </div>
    </main>
  );
}
