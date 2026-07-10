import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { RateLimiter } from '../core/interfaces';
import type { Decision, LimitPolicy } from '../core/types';

export type KeyGenerator = (req: Request) => string;

export const ipKeyGenerator: KeyGenerator = (req) => req.ip ?? 'unknown';

export function apiKeyGenerator(headerName = 'x-api-key'): KeyGenerator {
    return (req) => {
        const value = req.headers[headerName.toLowerCase()];
        if (typeof value === 'string' && value.length > 0) return value;
        return req.ip ?? 'unknown';
    };
}

export interface RateLimitMiddlewareOptions {
    readonly limiter: RateLimiter;
    readonly keyGenerator?: KeyGenerator;
    readonly policyOverride?: Partial<LimitPolicy>;
}

// X-RateLimit-* are advisory headers clients read to self-throttle.
// Reset is unix seconds; Retry-After (only on a 429) is delta seconds.
export function setRateLimitHeaders(res: Response, decision: Decision): void {
    res.setHeader('X-RateLimit-Limit', decision.limit);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, decision.remaining));
    res.setHeader('X-RateLimit-Reset', Math.ceil(decision.resetAtMs / 1000));
    if (!decision.allowed && decision.retryAfterMs !== undefined) {
        res.setHeader('Retry-After', Math.ceil(decision.retryAfterMs / 1000));
    }
}

export function rateLimit(options: RateLimitMiddlewareOptions): RequestHandler {
    const keyGen = options.keyGenerator ?? ipKeyGenerator;

    return (req: Request, res: Response, next: NextFunction): void => {
        void (async () => {
            try {
                const key = keyGen(req);
                const decision = await options.limiter.check(key, options.policyOverride);
                setRateLimitHeaders(res, decision);

                if (decision.allowed) {
                    next();
                    return;
                }

                res.status(429).json({
                    error: {
                        type: 'rate_limit_exceeded',
                        message: 'Too many requests',
                        limit: decision.limit,
                        remaining: decision.remaining,
                        retryAfterMs: decision.retryAfterMs ?? 0,
                        resetAt: new Date(decision.resetAtMs).toISOString(),
                        degraded: decision.degraded,
                    },
                });
            } catch (err) {
                // A real bug (e.g. ScriptExecutionError) — hand to the error handler,
                // never silently allow or crash the request.
                next(err);
            }
        })();
    };
}