import { ApiError } from "./errors.js";

/** Fixed-window limiter (per process). Use a shared store if running several instances. */
export class RateLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  check(key: string, limit: number, windowMs: number) {
    const now = Date.now();
    let h = this.hits.get(key);
    if (!h || h.reset <= now) this.hits.set(key, (h = { n: 0, reset: now + windowMs }));
    if (++h.n > limit) throw new ApiError(429, "RATE_LIMITED", "Too many attempts. Please wait a moment and try again.");
    if (this.hits.size > 20000) for (const [k, v] of this.hits) if (v.reset <= now) this.hits.delete(k);
  }
}
