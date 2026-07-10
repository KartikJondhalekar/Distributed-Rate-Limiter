/// <reference types="jest" />

import { loadConfig } from '../../src/config';
import { ConfigError } from '../../src/core/errors';

const base = { REDIS_URL: 'redis://localhost:6379' };

describe('loadConfig', () => {
    test('loads defaults when only REDIS_URL is set', () => {
        const c = loadConfig({ ...base } as NodeJS.ProcessEnv);
        expect(c.DEFAULT_ALGORITHM).toBe('token-bucket');
        expect(c.DEFAULT_WINDOW_MS).toBe(60_000);
        expect(c.DEFAULT_MAX_REQUESTS).toBe(100);
        expect(c.FAILURE_MODE).toBe('fail-open');
    });

    test('leaves optional bucket tuning unset (derived downstream)', () => {
        const c = loadConfig({ ...base } as NodeJS.ProcessEnv);
        expect(c.DEFAULT_BUCKET_CAPACITY).toBeUndefined();
        expect(c.DEFAULT_REFILL_RATE_PER_SEC).toBeUndefined();
    });

    test.each([
        ['missing REDIS_URL', {}],
        ['malformed REDIS_URL', { REDIS_URL: 'not-a-url' }],
        ['negative maxRequests', { ...base, DEFAULT_MAX_REQUESTS: '-5' }],
        ['non-numeric window', { ...base, DEFAULT_WINDOW_MS: 'abc' }],
        ['zero window', { ...base, DEFAULT_WINDOW_MS: '0' }],
        ['port collision', { ...base, API_PORT: '4000', METRICS_PORT: '4000' }],
        ['bad algorithm', { ...base, DEFAULT_ALGORITHM: 'leaky-bucket' }],
        ['capacity below max when set', {
            ...base,
            DEFAULT_MAX_REQUESTS: '100',
            DEFAULT_BUCKET_CAPACITY: '50',
        }],
    ])('rejects: %s', (_name, env) => {
        expect(() => loadConfig(env as NodeJS.ProcessEnv)).toThrow(ConfigError);
    });

    test('returns a frozen, immutable object', () => {
        const c = loadConfig({ ...base } as NodeJS.ProcessEnv);
        expect(Object.isFrozen(c)).toBe(true);
    });

    test('coerces string env values to numbers', () => {
        const c = loadConfig({ ...base, DEFAULT_MAX_REQUESTS: '42' } as NodeJS.ProcessEnv);
        expect(c.DEFAULT_MAX_REQUESTS).toBe(42);
        expect(typeof c.DEFAULT_MAX_REQUESTS).toBe('number');
    });
});