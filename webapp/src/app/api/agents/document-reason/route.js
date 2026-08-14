import { NextResponse } from 'next/server';
import { documentReason } from '@/lib/agents/documentReason';
import { guard } from '@/lib/guard';

export async function POST(request) {
  const blocked = guard(request, 'document-reason');
  if (blocked) return blocked;

  try {
    const result = await documentReason(await request.json());
    return NextResponse.json(result);
  } catch (err) {
    console.error('[document-reason]', err.message);
    return NextResponse.json(
      { error: err.message, status: 'unavailable' },
      { status: err.status || 500 },
    );
  }
}
