'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';

const tabs = [
  {
    href: '/',
    label: 'Обзор',
    icon: (
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
    ),
  },
  {
    href: '/transactions',
    label: 'Расходы',
    icon: (
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
    ),
  },
  {
    href: '/plan',
    label: 'План',
    icon: (
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
    ),
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
        backgroundColor: 'rgba(250, 250, 250, 0.85)',
        borderTop: '1px solid var(--border-subtle)',
      }}
    >
      <div className="max-w-lg mx-auto flex">
        {tabs.map(tab => {
          const isActive = pathname === tab.href;
          return (
            <Link
              key={tab.href}
              href={`${tab.href}${suffix}`}
              className="flex-1 flex flex-col items-center py-2.5 pb-3 transition-colors"
              style={{
                color: isActive ? 'var(--text-primary)' : 'var(--text-quaternary)',
              }}
            >
              <svg
                className="w-[20px] h-[20px]"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={isActive ? 2 : 1.5}
              >
                {tab.icon}
              </svg>
              <span className="text-[10px] mt-0.5 font-medium tracking-tight">{tab.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
