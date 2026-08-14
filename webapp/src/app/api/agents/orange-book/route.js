import { NextResponse } from 'next/server';
import { orangeBook } from '@/lib/agents/orangeBook';
import { guard } from '@/lib/guard';

export async function POST(request) {
  const blocked = guard(request, 'orange-book');
  if (blocked) return blocked;

  try {
    const result = await orangeBook(await request.json());
    return NextResponse.json(result);
  } catch (err) {
    console.error('[orange-book]', err.message);
    return NextResponse.json(
      { error: err.message, status: 'unavailable' },
      { status: err.status || 500 },
    );
  }
}
