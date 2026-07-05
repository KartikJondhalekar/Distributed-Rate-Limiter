import type { ALGORITHMS, FAILURE_MODES } from '../config/schema';

export type Algorithm = (typeof ALGORITHMS)[number];
export type FailureMode = (typeof FAILURE_MODES)[number];

export interface LimitPolicy {
    readonly algorithm: Algorithm;
    readonly windowMs: number;
    readonly maxRequests: number;
    // Token bucket only.
    readonly bucketCapacity?: number;
    readonly refillRatePerSec?: number;
}

export interface Decision {
    readonly allowed: boolean;
    readonly limit: number;
    readonly remaining: number;
    readonly resetAtMs: number;
    readonly retryAfterMs?: number;
    // True when we couldn't reach the store and fell back to the failure mode.
    readonly degraded: boolean;
}

export type ScriptResult = readonly number[];