import { NextResponse } from 'next/server';
import { getUsersInFamily } from '@/lib/db/queries';
import { DEFAULT_FAMILY_ID } from '@/lib/constants';

export const dynamic = 'force-dynamic';

export async function GET() {
  const users = await getUsersInFamily(DEFAULT_FAMILY_ID);
  return NextResponse.json(users.map(u => ({ id: u.id, name: u.name })));
}
