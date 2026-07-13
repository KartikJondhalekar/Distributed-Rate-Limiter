import type { Config } from '../config';
import type {
    Clock,
    KeyBuilder,
    Logger,
    MetricsSink,
    RateLimitAlgorithm,
    RateLimitStore,
    RateLimiter,
} from './interfaces';
import type { Algorithm, Decision, FailureMode, LimitPolicy } from './types';
import { StoreUnavailableError } from './errors';
import { TokenBucketAlgorithm } from '../algorithms/token-bucket';
import { SlidingWindowLogAlgorithm } from '../algorithms/sliding-window-log';
import { SlidingWindowCounterAlgorithm } from '../algorithms/sliding-window-counter';

export interface RateLimiterDeps {
    readonly store: RateLimitStore;
    readonly algorithm: RateLimitAlgorithm;
    readonly keyBuilder: KeyBuilder;
    readonly clock: Clock;
    readonly logger: Logger;
    readonly metrics?: MetricsSink;
    readonly failureMode: FailureMode;
    readonly defaultPolicy: LimitPolicy;
}

export class DefaultRateLimiter implements RateLimiter {
    constructor(private readonly deps: RateLimiterDeps) { }

    async check(clientKey: string, override?: Partial<LimitPolicy>): Promise<Decision> {
        const policy: LimitPolicy = { ...this.deps.defaultPolicy, ...override };
        const fullKey = this.deps.keyBuilder.build(clientKey);
        const script = this.deps.algorithm.buildScript(fullKey, policy);

        const started = this.deps.clock.nowMs();
        try {
            const raw = await this.deps.store.evaluate(script);
            const decision = this.deps.algorithm.interpret(raw, policy, this.deps.clock.nowMs());
            this.observeLatency(started);
            this.record(decision);
            return decision;
        } catch (err) {
            this.observeLatency(started);
            if (err instanceof StoreUnavailableError) {
                return this.degraded(policy);
            }
            // ScriptExecutionError and anything else are real bugs — let them bubble.
            throw err;
        }
    }

    private observeLatency(startedMs: number): void {
        this.deps.metrics?.observeHistogram(
            'rate_limiter_redis_latency_ms',
            this.deps.clock.nowMs() - startedMs,
            { algorithm: this.deps.algorithm.name },
        );
    }

    private degraded(policy: LimitPolicy): Decision {
        const open = this.deps.failureMode === 'fail-open';
        this.deps.logger.warn('rate limiter degraded', {
            failureMode: this.deps.failureMode,
            decision: open ? 'allow' : 'reject',
        });
        this.deps.metrics?.incrCounter('rate_limiter_degraded_total', { mode: this.deps.failureMode });

        const now = this.deps.clock.nowMs();
        const base = {
            allowed: open,
            limit: policy.maxRequests,
            remaining: open ? policy.maxRequests : 0,
            resetAtMs: now + policy.windowMs,
            degraded: true,
        };
        return open ? base : { ...base, retryAfterMs: policy.windowMs };
    }

    private record(decision: Decision): void {
        const labels = { algorithm: this.deps.algorithm.name };
        this.deps.metrics?.incrCounter('rate_limiter_requests_total', labels);
        if (!decision.allowed) {
            this.deps.metrics?.incrCounter('rate_limiter_hits_total', labels);
        }
    }
}

export function selectAlgorithm(name: Algorithm): RateLimitAlgorithm {
    switch (name) {
        case 'token-bucket':
            return new TokenBucketAlgorithm();
        case 'sliding-window-log':
            return new SlidingWindowLogAlgorithm();
        case 'sliding-window-counter':
            return new SlidingWindowCounterAlgorithm();
    }
}

export function policyFromConfig(config: Config): LimitPolicy {
    return {
        algorithm: config.DEFAULT_ALGORITHM,
        windowMs: config.DEFAULT_WINDOW_MS,
        maxRequests: config.DEFAULT_MAX_REQUESTS,
        ...(config.DEFAULT_BUCKET_CAPACITY !== undefined
            ? { bucketCapacity: config.DEFAULT_BUCKET_CAPACITY }
            : {}),
        ...(config.DEFAULT_REFILL_RATE_PER_SEC !== undefined
            ? { refillRatePerSec: config.DEFAULT_REFILL_RATE_PER_SEC }
            : {}),
    };
}