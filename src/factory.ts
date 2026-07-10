import type { Redis } from 'ioredis';
import type { Config } from './config';
import type { Logger, MetricsSink, RateLimiter } from './core/interfaces';
import { RedisRateLimitStore } from './store/redis-store';
import { SystemClock } from './core/system-clock';
import { HashTagKeyBuilder } from './core/key-builder';
import { DefaultRateLimiter, selectAlgorithm, policyFromConfig } from './core/limiter';

export function buildRateLimiter(
    config: Config,
    client: Redis,
    logger: Logger,
    metrics?: MetricsSink,
): RateLimiter {
    const store = new RedisRateLimitStore({ client, timeoutMs: config.REDIS_TIMEOUT_MS, logger });
    return new DefaultRateLimiter({
        store,
        algorithm: selectAlgorithm(config.DEFAULT_ALGORITHM),
        keyBuilder: new HashTagKeyBuilder(config.REDIS_KEY_PREFIX),
        clock: new SystemClock(),
        logger,
        failureMode: config.FAILURE_MODE,
        defaultPolicy: policyFromConfig(config),
        ...(metrics ? { metrics } : {}),
    });
}