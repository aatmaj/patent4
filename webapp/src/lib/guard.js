import { NextResponse } from 'next/server';

/**
 * Access control for the API routes.
 *
 * Every route here spends real money: an orchestrator run fans out to ~10
 * Claude calls plus several BigQuery jobs. Left open, that is a cost
 * amplifier for anyone who can reach the app.
 *
 * Two independent controls, both opt-in so local development is unchanged:
 *
 *   API_ACCESS_TOKEN  — when set, requests must send
 *                       `Authorization: Bearer <token>`.
 *   RATE_LIMIT_PER_MIN — per-IP request ceiling per route (default 20).
 *
 * The rate limiter is in-process. That is sufficient for a single-instance
 * deployment; behind multiple instances or on serverless it degrades to a
 * per-instance limit, so put a real limiter (or an auth proxy) in front
 * before exposing this publicly.
 */

const WINDOW_MS = 60_000;
const buckets = new Map();

function rateLimited(key, limit) {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || now - bucket.start >= WINDOW_MS) {
    buckets.set(key, { start: now, count: 1 });
    // Opportunistic cleanup so the map cannot grow without bound.
    if (buckets.size > 5000) {
      for (const [k, v] of buckets) {
        if (now - v.start >= WINDOW_MS) buckets.delete(k);
      }
    }
    return false;
  }

  bucket.count += 1;
  return bucket.count > limit;
}

function clientIp(request) {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return request.headers.get('x-real-ip') || 'local';
}

/**
 * @returns {NextResponse|null} a response to return immediately, or null to proceed.
 */
export function guard(request, routeKey, { limit } = {}) {
  const expected = process.env.API_ACCESS_TOKEN;
  if (expected) {
    const header = request.headers.get('authorization') || '';
    const provided = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!provided || !safeEqual(provided, expected)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const perMin = limit ?? Number(process.env.RATE_LIMIT_PER_MIN || 20);
  if (perMin > 0 && rateLimited(`${routeKey}:${clientIp(request)}`, perMin)) {
    return NextResponse.json(
      { error: `Rate limit exceeded (${perMin}/min for ${routeKey}).` },
      { status: 429, headers: { 'Retry-After': '60' } },
    );
  }

  return null;
}

/** Constant-time-ish comparison so the token cannot be probed byte by byte. */
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Reset internal state. Test helper only. */
export function __resetRateLimiter() {
  buckets.clear();
}
