/**
 * Process-local sliding-window rate limiter. State lives in a module-level
 * Map, so it resets on cold start / redeploy and is not shared across
 * concurrent instances — acceptable for a single-instance Vercel deployment
 * at this stage, but not correct once the app scales to multiple instances.
 *
 * For multi-instance deployment, replace with a Redis-backed counter (e.g.
 * Upstash) using the same key/limit/window interface.
 */

const requestTimestamps = new Map<string, number[]>();

export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number
): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  const windowStart = now - windowMs;

  const timestamps = (requestTimestamps.get(key) ?? []).filter((ts) => ts > windowStart);

  const resetAt = timestamps.length > 0 ? timestamps[0] + windowMs : now + windowMs;

  if (timestamps.length >= limit) {
    requestTimestamps.set(key, timestamps);
    return { allowed: false, remaining: 0, resetAt };
  }

  timestamps.push(now);
  requestTimestamps.set(key, timestamps);

  return { allowed: true, remaining: limit - timestamps.length, resetAt };
}
