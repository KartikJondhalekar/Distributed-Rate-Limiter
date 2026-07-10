import { z } from 'zod';

export const ALGORITHMS = [
    'token-bucket',
    'sliding-window-log',
    'sliding-window-counter',
] as const;

export const FAILURE_MODES = ['fail-open', 'fail-closed'] as const;

const positiveInt = (label: string) =>
    z.coerce
        .number({ invalid_type_error: `${label} must be a number` })
        .int(`${label} must be an integer`)
        .positive(`${label} must be greater than 0`);

const positiveNumber = (label: string) =>
    z.coerce
        .number({ invalid_type_error: `${label} must be a number` })
        .positive(`${label} must be greater than 0`);

const port = (label: string) =>
    positiveInt(label).max(65535, `${label} must be <= 65535`);

// No default for REDIS_URL on purpose: we'd rather fail loudly than
// silently point at localhost in prod.
export const configSchema = z
    .object({
        NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
        LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

        REDIS_URL: z.string().url('REDIS_URL must be a valid URL, e.g. redis://localhost:6379'),
        REDIS_KEY_PREFIX: z.string().min(1, 'REDIS_KEY_PREFIX must not be empty').default('rl'),
        REDIS_TIMEOUT_MS: positiveInt('REDIS_TIMEOUT_MS').default(50),

        DEFAULT_ALGORITHM: z.enum(ALGORITHMS).default('token-bucket'),
        DEFAULT_WINDOW_MS: positiveInt('DEFAULT_WINDOW_MS').default(60_000),
        DEFAULT_MAX_REQUESTS: positiveInt('DEFAULT_MAX_REQUESTS').default(100),
        DEFAULT_BUCKET_CAPACITY: positiveInt('DEFAULT_BUCKET_CAPACITY').optional(),
        DEFAULT_REFILL_RATE_PER_SEC: positiveNumber('DEFAULT_REFILL_RATE_PER_SEC').optional(),

        FAILURE_MODE: z.enum(FAILURE_MODES).default('fail-open'),

        API_PORT: port('API_PORT').default(3000),
        METRICS_PORT: port('METRICS_PORT').default(9090),
    })
    .superRefine((cfg, ctx) => {
        if (cfg.API_PORT === cfg.METRICS_PORT) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['METRICS_PORT'],
                message: 'METRICS_PORT must differ from API_PORT',
            });
        }
        // Only enforceable when an explicit capacity is set; otherwise capacity
        // is derived from maxRequests and this can't be violated.
        if (
            cfg.DEFAULT_BUCKET_CAPACITY !== undefined &&
            cfg.DEFAULT_BUCKET_CAPACITY < cfg.DEFAULT_MAX_REQUESTS
        ) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['DEFAULT_BUCKET_CAPACITY'],
                message: 'DEFAULT_BUCKET_CAPACITY must be >= DEFAULT_MAX_REQUESTS so a full burst is absorbable',
            });
        }
    });

export type RawConfig = z.infer<typeof configSchema>;