import { NextResponse } from 'next/server';
import { patentFto } from '@/lib/agents/patentFto';
import { guard } from '@/lib/guard';

export async function POST(request) {
  const blocked = guard(request, 'patent-fto');
  if (blocked) return blocked;

  try {
    const result = await patentFto(await request.json());
    return NextResponse.json(result);
  } catch (err) {
    console.error('[patent-fto]', err.message);
    return NextResponse.json(
      { error: err.message, status: 'unavailable' },
      { status: err.status || 500 },
    );
  }
}
