import { TokenBucketAlgorithm } from '../../src/algorithms/token-bucket';
import { SlidingWindowLogAlgorithm } from '../../src/algorithms/sliding-window-log';
import { SlidingWindowCounterAlgorithm } from '../../src/algorithms/sliding-window-counter';
import type { LimitPolicy } from '../../src/core/types';

const tb = new TokenBucketAlgorithm();
const swl = new SlidingWindowLogAlgorithm();
const swc = new SlidingWindowCounterAlgorithm();

const policy: LimitPolicy = { algorithm: 'token-bucket', windowMs: 10_000, maxRequests: 5 };

describe('interpret()', () => {
    test.each([
        ['allowed', [1, 3, 0, 999], true, 3],
        ['rejected', [0, 0, 1500, 999], false, 0],
    ])('token-bucket %s', (_n, raw, allowed, remaining) => {
        const d = tb.interpret(raw as number[], policy, 0);
        expect(d.allowed).toBe(allowed);
        expect(d.remaining).toBe(remaining);
        expect(d.degraded).toBe(false);
    });

    test('rejected carries retryAfterMs; allowed omits it', () => {
        expect(tb.interpret([0, 0, 1500, 999], policy, 0).retryAfterMs).toBe(1500);
        expect(tb.interpret([1, 3, 0, 999], policy, 0).retryAfterMs).toBeUndefined();
    });

    test('limit reflects bucketCapacity when set, else maxRequests', () => {
        expect(tb.interpret([1, 19, 0, 1], { ...policy, bucketCapacity: 20 }, 0).limit).toBe(20);
        expect(tb.interpret([1, 4, 0, 1], policy, 0).limit).toBe(5);
    });

    test('sliding-window-log and -counter map allowed/rejected consistently', () => {
        expect(swl.interpret([1, 2, 0, 9], policy, 0).allowed).toBe(true);
        expect(swl.interpret([0, 0, 300, 9], policy, 0).retryAfterMs).toBe(300);
        expect(swc.interpret([1, 4, 0, 9], policy, 0).allowed).toBe(true);
        expect(swc.interpret([0, 0, 800, 9], policy, 0).retryAfterMs).toBe(800);
    });
});

describe('buildScript()', () => {
    test('token-bucket derives capacity + rate from the limit when unset', () => {
        const s = tb.buildScript('rl:{k}', policy);
        expect(s.keys).toEqual(['rl:{k}']);
        expect(s.args[0]).toBe('5'); // capacity = maxRequests
        expect(s.args[1]).toBe('0.5'); // 5 / (10000/1000)
        expect(s.args[2]).toBe('1'); // requested
    });

    test('token-bucket honors explicit capacity + rate overrides', () => {
        const s = tb.buildScript('rl:{k}', { ...policy, bucketCapacity: 20, refillRatePerSec: 2 });
        expect(s.args[0]).toBe('20');
        expect(s.args[1]).toBe('2');
    });

    test('sliding-window-log passes window, limit, and a unique member', () => {
        const s = swl.buildScript('rl:{k}', policy);
        expect(s.args[0]).toBe('10000');
        expect(s.args[1]).toBe('5');
        expect(typeof s.args[2]).toBe('string');
        const a = swl.buildScript('rl:{k}', policy).args[2];
        const b = swl.buildScript('rl:{k}', policy).args[2];
        expect(a).not.toBe(b);
    });

    test('sliding-window-counter passes window and limit', () => {
        expect(swc.buildScript('rl:{k}', policy).args).toEqual(['10000', '5']);
    });
});