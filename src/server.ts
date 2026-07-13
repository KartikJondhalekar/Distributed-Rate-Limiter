import 'dotenv/config';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { Redis } from 'ioredis';
import { loadConfig } from './config';
import { buildRateLimiter } from './factory';
import { RedisRateLimitStore } from './store/redis-store';
import { rateLimit } from './middleware/express';
import { createRateLimitRouter } from './api/rate-limit-router';
import { ConsoleJsonLogger } from './observability/logger';
import { PrometheusMetrics } from './observability/metrics';
import { startMetricsServer } from './observability/metrics-server';

function main(): void {
    const config = loadConfig();
    const logger = new ConsoleJsonLogger(config.LOG_LEVEL);
    const metrics = new PrometheusMetrics();

    const client = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1 });
    client.on('error', (err: Error) => logger.error('redis client error', { error: err.message }));

    const store = new RedisRateLimitStore({ client, timeoutMs: config.REDIS_TIMEOUT_MS, logger });
    const limiter = buildRateLimiter(config, client, logger, metrics);

    const app = express();
    // Respect X-Forwarded-For so req.ip is the real client behind a load balancer.
    app.set('trust proxy', true);

    // Language-agnostic REST surface: POST /check, GET /health.
    app.use('/', createRateLimitRouter({ limiter, store }));

    // Demo of the middleware guarding a route. Small policy so a handful of
    // curls trip the limit; real routes would use the configured default.
    app.get(
        '/api/ping',
        rateLimit({
            limiter,
            policyOverride: {
                algorithm: 'token-bucket',
                windowMs: 10_000,
                maxRequests: 5,
                bucketCapacity: 5,
                refillRatePerSec: 0.5,
            },
        }),
        (_req: Request, res: Response) => {
            res.json({ pong: true });
        },
    );

    app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
        const e = err as { status?: number; statusCode?: number; message?: string };
        const status = e.status ?? e.statusCode ?? 500;

        // 4xx is the caller's fault (e.g. malformed JSON body) — say what's wrong.
        // 5xx is ours — log it and return an opaque message.
        if (status < 500) {
            logger.warn('bad request', { status, error: e.message });
            res.status(status).json({
                error: { type: 'invalid_request', message: e.message ?? 'Bad request' },
            });
            return;
        }

        logger.error('unhandled request error', { error: e.message });
        res.status(500).json({ error: { type: 'internal_error', message: 'Internal server error' } });
    });

    const apiServer = app.listen(config.API_PORT, () => {
        logger.info('rate limiter listening', { port: config.API_PORT, mode: config.FAILURE_MODE });
    });
    const metricsServer = startMetricsServer(config.METRICS_PORT, metrics, logger);

    const shutdown = (signal: string): void => {
        logger.info('shutting down', { signal });
        apiServer.close(() => {
            metricsServer.close(() => {
                void client.quit().finally(() => {
                    process.exitCode = 0;
                });
            });
        });
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();