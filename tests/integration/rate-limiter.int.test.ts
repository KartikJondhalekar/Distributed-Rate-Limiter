import { expect, describe, test, beforeAll, afterAll } from '@jest/globals';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { RedisRateLimitStore } from '../../src/store/redis-store';
import { DefaultRateLimiter } from '../../src/core/limiter';
import { TokenBucketAlgorithm } from '../../src/algorithms/token-bucket';
import { SlidingWindowLogAlgorithm } from '../../src/algorithms/sliding-window-log';
import { HashTagKeyBuilder } from '../../src/core/key-builder';
import { SystemClock } from '../../src/core/system-clock';
import type { RateLimitAlgorithm } from '../../src/core/interfaces';
import type { LimitPolicy } from '../../src/core/types';
import { noopLogger } from '../support/helpers';

let container: StartedRedisContainer;
let client: Redis;

beforeAll(async () => {
    container = await new RedisContainer('redis:7-alpine').start();
    client = new Redis(container.getConnectionUrl());
});

afterAll(async () => {
    if (client) await client.quit();
    if (container) await container.stop();
});

function limiter(algorithm: RateLimitAlgorithm, defaultPolicy: LimitPolicy): DefaultRateLimiter {
    return new DefaultRateLimiter({
        store: new RedisRateLimitStore({ client, timeoutMs: 1000, logger: noopLogger }),
        algorithm,
        keyBuilder: new HashTagKeyBuilder('itest'),
        clock: new SystemClock(),
        logger: noopLogger,
        failureMode: 'fail-open',
        defaultPolicy,
    });
}

describe('token bucket (real Redis)', () => {
    test('admits up to capacity, then rejects', async () => {
        const l = limiter(new TokenBucketAlgorithm(), {
            algorithm: 'token-bucket',
            windowMs: 60_000,
            maxRequests: 5,
            bucketCapacity: 5,
            refillRatePerSec: 0.0001, // effectively no refill during the test
        });
        const key = `tb-${Date.now()}`;
        const results: boolean[] = [];
        for (let i = 0; i < 7; i++) results.push((await l.check(key)).allowed);

        expect(results.filter(Boolean).length).toBe(5);
        expect(results.slice(5)).toEqual([false, false]);
    });

    test('refills over time (temporal recovery)', async () => {
        const l = limiter(new TokenBucketAlgorithm(), {
            algorithm: 'token-bucket',
            windowMs: 1_000,
            maxRequests: 1,
            bucketCapacity: 1,
            refillRatePerSec: 50,
        });
        const key = `tb-refill-${Date.now()}`;

        expect((await l.check(key)).allowed).toBe(true); // consume the only token
        expect((await l.check(key)).allowed).toBe(false); // empty now
        await new Promise((r) => setTimeout(r, 120)); // 50/s → ~6 tokens accrue
        expect((await l.check(key)).allowed).toBe(true); // recovered
    });
});

describe('sliding window log (real Redis)', () => {
    test('enforces an exact count within the window', async () => {
        const l = limiter(new SlidingWindowLogAlgorithm(), {
            algorithm: 'sliding-window-log',
            windowMs: 60_000,
            maxRequests: 3,
        });
        const key = `swl-${Date.now()}`;
        const outcomes: boolean[] = [];
        for (let i = 0; i < 5; i++) outcomes.push((await l.check(key)).allowed);

        expect(outcomes).toEqual([true, true, true, false, false]);
    });

    test('atomicity: 50 concurrent requests admit EXACTLY the limit', async () => {
        const l = limiter(new SlidingWindowLogAlgorithm(), {
            algorithm: 'sliding-window-log',
            windowMs: 60_000,
            maxRequests: 10,
        });
        const key = `swl-concurrent-${Date.now()}`;

        const results = await Promise.all(Array.from({ length: 50 }, () => l.check(key)));
        const allowed = results.filter((r) => r.allowed).length;

        // The whole point of Lua atomicity: no TOCTOU overshoot under contention.
        expect(allowed).toBe(10);
    });
});