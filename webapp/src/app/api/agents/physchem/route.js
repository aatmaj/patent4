import { NextResponse } from 'next/server';
import { physchem } from '@/lib/agents/physchem';
import { guard } from '@/lib/guard';

export async function POST(request) {
  const blocked = guard(request, 'physchem');
  if (blocked) return blocked;

  try {
    const result = await physchem(await request.json());
    return NextResponse.json(result);
  } catch (err) {
    console.error('[physchem]', err.message);
    return NextResponse.json(
      { error: err.message, status: 'unavailable' },
      { status: err.status || 500 },
    );
  }
}
