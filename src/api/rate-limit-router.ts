import express, { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { RateLimiter, RateLimitStore } from '../core/interfaces';
import type { LimitPolicy } from '../core/types';
import { ALGORITHMS } from '../config/schema';
import { setRateLimitHeaders } from '../middleware/express';

export interface RateLimitRouterDeps {
  readonly limiter: RateLimiter;
  readonly store: RateLimitStore;
}

// Build a per-request policy override from whatever the caller supplied.
// Anything absent falls back to the limiter's configured default policy.
function pickPolicy(body: Record<string, unknown>): Partial<LimitPolicy> {
  const alg = body.algorithm;
  return {
    ...(typeof alg === 'string' && (ALGORITHMS as readonly string[]).includes(alg)
      ? { algorithm: alg as LimitPolicy['algorithm'] }
      : {}),
    ...(typeof body.windowMs === 'number' ? { windowMs: body.windowMs } : {}),
    ...(typeof body.maxRequests === 'number' ? { maxRequests: body.maxRequests } : {}),
    ...(typeof body.bucketCapacity === 'number' ? { bucketCapacity: body.bucketCapacity } : {}),
    ...(typeof body.refillRatePerSec === 'number'
      ? { refillRatePerSec: body.refillRatePerSec }
      : {}),
  };
}

export function createRateLimitRouter(deps: RateLimitRouterDeps): Router {
  const router = Router();

  router.get('/health', (_req: Request, res: Response, next: NextFunction): void => {
    void (async () => {
      try {
        const ok = await deps.store.ping();
        res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'degraded', redis: ok });
      } catch (err) {
        next(err);
      }
    })();
  });

  router.post('/check', express.json(), (req: Request, res: Response, next: NextFunction): void => {
    void (async () => {
      try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        if (typeof body.key !== 'string' || body.key.length === 0) {
          res.status(400).json({
            error: { type: 'invalid_request', message: 'body.key (non-empty string) is required' },
          });
          return;
        }

        const decision = await deps.limiter.check(body.key, pickPolicy(body));
        setRateLimitHeaders(res, decision);

        // /check is an oracle: it always answers 200 with the verdict and
        // lets the caller decide how to enforce it.
        res.status(200).json({
          allowed: decision.allowed,
          limit: decision.limit,
          remaining: decision.remaining,
          resetAt: new Date(decision.resetAtMs).toISOString(),
          retryAfterMs: decision.retryAfterMs ?? 0,
          degraded: decision.degraded,
        });
      } catch (err) {
        next(err);
      }
    })();
  });

  return router;
}