import 'dotenv/config';
import { Redis } from 'ioredis';
import { loadConfig } from './config';
import type { Logger } from './core/interfaces';
import type { LimitPolicy } from './core/types';
import { SystemClock } from './core/system-clock';
import { HashTagKeyBuilder } from './core/key-builder';
import { RedisRateLimitStore } from './store/redis-store';
import { DefaultRateLimiter, selectAlgorithm } from './core/limiter';

const logger: Logger = {
    debug: (msg, f) => console.log(JSON.stringify({ level: 'debug', msg, ...f })),
    info: (msg, f) => console.log(JSON.stringify({ level: 'info', msg, ...f })),
    warn: (msg, f) => console.warn(JSON.stringify({ level: 'warn', msg, ...f })),
    error: (msg, f) => console.error(JSON.stringify({ level: 'error', msg, ...f })),
};

async function safeDel(client: Redis, key: string): Promise<void> {
    try {
        await client.del(key);
    } catch {
        // Redis may be down (that's the resilience demo) — ignore.
    }
}

async function main(): Promise<void> {
    const config = loadConfig();
    // retryStrategy: () => null makes the process fail fast (and exit) when
    // Redis is unreachable, instead of reconnecting forever.
    const client = new Redis(config.REDIS_URL, {
        maxRetriesPerRequest: 1,
        retryStrategy: () => null,
    });
    client.on('error', () => {
        /* handled per-command; swallow the noisy connection events */
    });

    const policy: LimitPolicy = {
        algorithm: 'token-bucket',
        windowMs: 10_000,
        maxRequests: 5,
        bucketCapacity: 5,
        refillRatePerSec: 0.5,
    };

    const limiter = new DefaultRateLimiter({
        store: new RedisRateLimitStore({ client, timeoutMs: config.REDIS_TIMEOUT_MS, logger }),
        algorithm: selectAlgorithm(policy.algorithm),
        keyBuilder: new HashTagKeyBuilder(config.REDIS_KEY_PREFIX),
        clock: new SystemClock(),
        logger,
        failureMode: config.FAILURE_MODE,
        defaultPolicy: policy,
    });

    const clientId = 'demo-client';
    const fullKey = `${config.REDIS_KEY_PREFIX}:{${clientId}}`;
    await safeDel(client, fullKey);

    logger.info('firing 8 requests against a bucket of 5', {
        algorithm: policy.algorithm,
        failureMode: config.FAILURE_MODE,
    });

    for (let i = 1; i <= 8; i++) {
        const d = await limiter.check(clientId);
        console.log(
            JSON.stringify({
                req: i,
                allowed: d.allowed,
                remaining: d.remaining,
                retryAfterMs: d.retryAfterMs ?? 0,
                degraded: d.degraded,
            }),
        );
    }

    await safeDel(client, fullKey);
    client.disconnect();
}

main().catch((err) => {
    logger.error('verification failed', { error: (err as Error).message });
    process.exitCode = 1;
});