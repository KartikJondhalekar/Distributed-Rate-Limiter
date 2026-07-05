import type { Decision, LimitPolicy, ScriptResult } from './types';

// For metric timestamps and logs, not for limit decisions — those use
// Redis TIME so all instances agree on the clock (see Phase 1 notes).
export interface Clock {
    nowMs(): number;
}

export interface Logger {
    debug(msg: string, fields?: Record<string, unknown>): void;
    info(msg: string, fields?: Record<string, unknown>): void;
    warn(msg: string, fields?: Record<string, unknown>): void;
    error(msg: string, fields?: Record<string, unknown>): void;
}

export interface MetricsSink {
    incrCounter(name: string, labels?: Record<string, string>, value?: number): void;
    observeHistogram(name: string, value: number, labels?: Record<string, string>): void;
}

// keys must land in the same Cluster slot, so the KeyBuilder hash-tags them.
export interface CompiledScript {
    readonly source: string;
    readonly keys: readonly string[];
    readonly args: readonly string[];
}

// Just runs scripts atomically. Knows nothing about rate limiting.
// Throws StoreUnavailableError so the caller can apply the failure mode.
export interface RateLimitStore {
    evaluate(script: CompiledScript): Promise<ScriptResult>;
    ping(): Promise<boolean>;
}

// One per algorithm. Builds the script, then reads its result back out.
export interface RateLimitAlgorithm {
    readonly name: string;
    buildScript(fullKey: string, policy: LimitPolicy): CompiledScript;
    interpret(raw: ScriptResult, policy: LimitPolicy, nowMs: number): Decision;
}

export interface KeyBuilder {
    build(clientKey: string): string;
}

// What callers actually use. Wires an algorithm to a store.
export interface RateLimiter {
    check(clientKey: string, policyOverride?: Partial<LimitPolicy>): Promise<Decision>;
}