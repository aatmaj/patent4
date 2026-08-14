import { NextResponse } from 'next/server';
import { arithmetic } from '@/lib/agents/arithmetic';
import { guard } from '@/lib/guard';

export async function POST(request) {
  const blocked = guard(request, 'arithmetic', { limit: 120 });
  if (blocked) return blocked;

  try {
    const body = await request.json();
    const result = arithmetic(body);
    return NextResponse.json({
      ...result,
      operation: body.operation,
      params: body.params,
      computedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[arithmetic]', err.message);
    return NextResponse.json(
      { error: err.message, status: 'unavailable' },
      { status: err.status || 400 },
    );
  }
}
