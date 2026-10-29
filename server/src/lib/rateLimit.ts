import { ApiError } from "./errors.js";

/**
 * Fixed-window in-memory rate limiter. Adequate for a single-instance deployment; replace with a
 * shared store (e.g. Redis) when running multiple API instances.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  check(bucket: string, key: string, limit: number, windowMs: number): void {
    const id = `${bucket}:${key}`;
    const t = this.now();
    let entry = this.hits.get(id);
    if (!entry || entry.resetAt <= t) {
      entry = { count: 0, resetAt: t + windowMs };
      this.hits.set(id, entry);
    }
    entry.count += 1;
    if (entry.count > limit) {
      const retryAfter = Math.ceil((entry.resetAt - t) / 1000);
      throw new ApiError(429, "RATE_LIMITED", `Too many attempts. Try again in ${retryAfter} seconds.`, {
        retry_after_seconds: retryAfter,
      });
    }
    if (this.hits.size > 50_000) this.sweep(t);
  }

  private sweep(t: number) {
    for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
  }
}
