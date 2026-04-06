'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';

const tabs = [
  {
    href: '/',
    label: 'Обзор',
    icon: <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />,
  },
  {
    href: '/transactions',
    label: 'Расходы',
    icon: <path strokeLinecap="round" strokeLinejoin="round" d="M19 14l-7 7m0 0l-7-7m7 7V3" />,
  },
  {
    href: '/income',
    label: 'Доходы',
    icon: <path strokeLinecap="round" strokeLinejoin="round" d="M5 10l7-7m0 0l7 7m-7-7v18" />,
  },
  {
    href: '/debts',
    label: 'Долги',
    icon: <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />,
  },
  {
    href: '/plan',
    label: 'План',
    icon: <path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />,
  },
];

export default function Nav() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const qs = searchParams.toString();
  const suffix = qs ? `?${qs}` : '';

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-50 safe-area-pb backdrop-blur-xl"
      style={{
        backgroundColor: 'rgba(255, 255, 255, 0.85)',
        borderTop: '1px solid var(--ink-6)',
      }}
    >
      <div className="max-w-lg mx-auto flex">
        {tabs.map(tab => {
          const isActive = pathname === tab.href;
          return (
            <Link
              key={tab.href}
              href={`${tab.href}${suffix}`}
              className="flex-1 flex flex-col items-center py-2.5 transition-colors"
              style={{ color: isActive ? 'var(--ink-1)' : 'var(--ink-4)' }}
            >
              <svg
                className="w-[18px] h-[18px]"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={isActive ? 2.2 : 1.5}
              >
                {tab.icon}
              </svg>
              <span className="text-[9px] mt-0.5 font-medium">{tab.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
