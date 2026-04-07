'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Force the server component to re-fetch data when this page mounts.
 * Solves Next.js Router Cache showing stale data on tab navigation.
 */
export default function RefreshOnMount() {
  const router = useRouter();
  useEffect(() => {
    router.refresh();
  }, [router]);
  return null;
}
