import { NextResponse } from 'next/server';
import { getUsers } from '@/lib/db/queries';

export const dynamic = 'force-dynamic';

export async function GET() {
  const users = await getUsers();
  return NextResponse.json(users.map(u => ({ id: u.id, name: u.name })));
}
