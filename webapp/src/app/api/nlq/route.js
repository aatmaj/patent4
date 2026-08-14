import { NextResponse } from 'next/server';
import { nlq } from '@/lib/agents/nlq';
import { guard } from '@/lib/guard';

export async function POST(request) {
  const blocked = guard(request, 'nlq', {
    limit: Number(process.env.RATE_LIMIT_NLQ_PER_MIN || 10),
  });
  if (blocked) return blocked;

  try {
    const result = await nlq(await request.json());
    return NextResponse.json(result);
  } catch (err) {
    console.error('[nlq]', err.message);
    return NextResponse.json(
      { error: err.message || 'Failed to process natural language query' },
      { status: err.status || 500 },
    );
  }
}
