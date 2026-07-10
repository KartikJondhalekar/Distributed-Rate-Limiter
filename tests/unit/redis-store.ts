import { RedisRateLimitStore } from '../../src/store/redis-store';
import { ScriptExecutionError, StoreUnavailableError } from '../../src/core/errors';
import type { CompiledScript } from '../../src/core/interfaces';
import { noopLogger } from '../support/helpers';

const script: CompiledScript = { source: 'return {1,2,3,4}', keys: ['k'], args: ['a'] };

function replyError(message: string): Error {
    const e = new Error(message);
    e.name = 'ReplyError';
    return e;
}

type Handlers = {
    evalsha?: (...args: unknown[]) => unknown;
    eval?: (...args: unknown[]) => unknown;
    ping?: (...args: unknown[]) => unknown;
};

// Minimal stand-in for the ioredis client surface the store actually uses.
function makeClient(handlers: Handlers) {
    return {
        evalsha: handlers.evalsha ?? (async () => [1, 2, 3, 4]),
        eval: handlers.eval ?? (async () => [1, 2, 3, 4]),
        ping: handlers.ping ?? (async () => 'PONG'),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
}

function store(handlers: Handlers, timeoutMs = 50): RedisRateLimitStore {
    return new RedisRateLimitStore({ client: makeClient(handlers), timeoutMs, logger: noopLogger });
}

describe('RedisRateLimitStore', () => {
    test('returns a numeric vector on evalsha success', async () => {
        await expect(store({}).evaluate(script)).resolves.toEqual([1, 2, 3, 4]);
    });

    test('coerces string replies to numbers', async () => {
        await expect(store({ evalsha: async () => ['1', '0', '9'] }).evaluate(script)).resolves.toEqual([
            1, 0, 9,
        ]);
    });

    test('falls back to EVAL on NOSCRIPT, then caches', async () => {
        let evalCalls = 0;
        const s = store({
            evalsha: async () => {
                throw replyError('NOSCRIPT No matching script. Please use EVAL.');
            },
            eval: async () => {
                evalCalls += 1;
                return [9, 9, 9, 9];
            },
        });
        await expect(s.evaluate(script)).resolves.toEqual([9, 9, 9, 9]);
        expect(evalCalls).toBe(1);
    });

    test('classifies a Lua ReplyError as ScriptExecutionError (a bug, not an outage)', async () => {
        const s = store({
            evalsha: async () => {
                throw replyError('user_script:3: attempt to perform arithmetic on a nil value');
            },
        });
        await expect(s.evaluate(script)).rejects.toBeInstanceOf(ScriptExecutionError);
    });

    test('classifies a connection failure as StoreUnavailableError', async () => {
        const s = store({
            evalsha: async () => {
                throw new Error('Connection is closed.');
            },
        });
        await expect(s.evaluate(script)).rejects.toBeInstanceOf(StoreUnavailableError);
    });

    test('classifies a hang as StoreUnavailableError via the timeout', async () => {
        const s = store({ evalsha: () => new Promise(() => { }) }, 20);
        await expect(s.evaluate(script)).rejects.toBeInstanceOf(StoreUnavailableError);
    });

    test('ping resolves true on PONG and false on error', async () => {
        await expect(store({}).ping()).resolves.toBe(true);
        await expect(
            store({
                ping: async () => {
                    throw new Error('unreachable');
                },
            }).ping(),
        ).resolves.toBe(false);
    });
});