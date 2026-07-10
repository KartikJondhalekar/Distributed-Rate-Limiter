import { DefaultRateLimiter } from '../../src/core/limiter';
import { TokenBucketAlgorithm } from '../../src/algorithms/token-bucket';
import { HashTagKeyBuilder } from '../../src/core/key-builder';
import { ScriptExecutionError, StoreUnavailableError } from '../../src/core/errors';
import type { FailureMode, LimitPolicy } from '../../src/core/types';
import type { MetricsSink, RateLimitStore } from '../../src/core/interfaces';
import { FakeClock, FakeStore, RecordingMetrics, noopLogger } from '../support/helpers';

const policy: LimitPolicy = { algorithm: 'token-bucket', windowMs: 10_000, maxRequests: 5 };

function makeLimiter(
    store: RateLimitStore,
    failureMode: FailureMode = 'fail-open',
    metrics?: MetricsSink,
): DefaultRateLimiter {
    return new DefaultRateLimiter({
        store,
        algorithm: new TokenBucketAlgorithm(),
        keyBuilder: new HashTagKeyBuilder('rl'),
        clock: new FakeClock(),
        logger: noopLogger,
        failureMode,
        defaultPolicy: policy,
        ...(metrics ? { metrics } : {}),
    });
}

describe('DefaultRateLimiter', () => {
    test('passes an allowed decision through unchanged', async () => {
        const d = await makeLimiter(new FakeStore(async () => [1, 4, 0, 1234])).check('client-a');
        expect(d.allowed).toBe(true);
        expect(d.remaining).toBe(4);
        expect(d.degraded).toBe(false);
    });

    test('maps a rejected decision with retryAfterMs', async () => {
        const d = await makeLimiter(new FakeStore(async () => [0, 0, 2000, 5678])).check('client-a');
        expect(d.allowed).toBe(false);
        expect(d.retryAfterMs).toBe(2000);
    });

    test('fail-open ALLOWS (degraded) when the store is unavailable', async () => {
        const store = new FakeStore(async () => {
            throw new StoreUnavailableError('redis down');
        });
        const d = await makeLimiter(store, 'fail-open').check('client-a');
        expect(d.allowed).toBe(true);
        expect(d.degraded).toBe(true);
    });

    test('fail-closed REJECTS (degraded) when the store is unavailable', async () => {
        const store = new FakeStore(async () => {
            throw new StoreUnavailableError('redis down');
        });
        const d = await makeLimiter(store, 'fail-closed').check('client-a');
        expect(d.allowed).toBe(false);
        expect(d.degraded).toBe(true);
        expect(d.retryAfterMs).toBe(policy.windowMs);
    });

    test('a script error BUBBLES (never silently allowed)', async () => {
        const store = new FakeStore(async () => {
            throw new ScriptExecutionError('lua boom');
        });
        await expect(makeLimiter(store).check('client-a')).rejects.toBeInstanceOf(ScriptExecutionError);
    });

    test('records request + hit counters', async () => {
        const metrics = new RecordingMetrics();
        await makeLimiter(new FakeStore(async () => [0, 0, 100, 200]), 'fail-open', metrics).check('c');
        const names = metrics.counters.map((c) => c.name);
        expect(names).toContain('rate_limiter_requests_total');
        expect(names).toContain('rate_limiter_hits_total');
    });

    test('does not count a hit when allowed', async () => {
        const metrics = new RecordingMetrics();
        await makeLimiter(new FakeStore(async () => [1, 4, 0, 1]), 'fail-open', metrics).check('c');
        const names = metrics.counters.map((c) => c.name);
        expect(names).toContain('rate_limiter_requests_total');
        expect(names).not.toContain('rate_limiter_hits_total');
    });

    test('applies hash-tagged key to the compiled script', async () => {
        const store = new FakeStore(async () => [1, 4, 0, 1]);
        await makeLimiter(store).check('client-a');
        expect(store.lastScript?.keys[0]).toBe('rl:{client-a}');
    });

    test('per-call override merges over the default policy', async () => {
        const store = new FakeStore(async () => [1, 2, 0, 1]);
        await makeLimiter(store).check('client-a', { maxRequests: 3 });
        // capacity derives from the overridden maxRequests (3), not the default 5
        expect(store.lastScript?.args[0]).toBe('3');
    });
});