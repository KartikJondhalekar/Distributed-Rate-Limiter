import type { RateLimitAlgorithm, CompiledScript } from '../core/interfaces';
import type { Decision, LimitPolicy, ScriptResult } from '../core/types';

// Time comes from redis.call('TIME'), never from the caller, so every
// instance agrees on the clock. Refill is proportional to elapsed time.
// Returns: { allowed, remaining, retryAfterMs, resetAtMs } as integers.
const LUA = `
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local requested = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])

local t = redis.call('TIME')
local now_ms = (tonumber(t[1]) * 1000) + math.floor(tonumber(t[2]) / 1000)

local data = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(data[1])
local last = tonumber(data[2])
if tokens == nil then tokens = capacity end
if last == nil then last = now_ms end

local elapsed = now_ms - last
if elapsed < 0 then elapsed = 0 end
tokens = math.min(capacity, tokens + (elapsed / 1000.0) * rate)

local allowed = 0
if tokens >= requested then
  tokens = tokens - requested
  allowed = 1
end

redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now_ms)
redis.call('PEXPIRE', KEYS[1], ttl)

local retry_after = 0
if allowed == 0 then
  retry_after = math.ceil(((requested - tokens) / rate) * 1000)
end
local reset_at = now_ms + math.ceil(((capacity - tokens) / rate) * 1000)

return { allowed, math.floor(tokens), retry_after, reset_at }
`;

export class TokenBucketAlgorithm implements RateLimitAlgorithm {
    readonly name = 'token-bucket';

    buildScript(fullKey: string, policy: LimitPolicy): CompiledScript {
        const capacity = policy.bucketCapacity ?? policy.maxRequests;
        const rate = policy.refillRatePerSec ?? policy.maxRequests / (policy.windowMs / 1000);
        const requested = 1;
        // Expire an idle bucket once it would have fully refilled, plus a margin.
        const ttl = Math.ceil((capacity / rate) * 1000) + 1000;
        return {
            source: LUA,
            keys: [fullKey],
            args: [String(capacity), String(rate), String(requested), String(ttl)],
        };
    }

    interpret(raw: ScriptResult, policy: LimitPolicy, _nowMs: number): Decision {
        const allowed = (raw[0] ?? 0) === 1;
        const remaining = raw[1] ?? 0;
        const retryAfterMs = raw[2] ?? 0;
        const resetAtMs = raw[3] ?? 0;
        const limit = policy.bucketCapacity ?? policy.maxRequests;

        const base = { allowed, limit, remaining, resetAtMs, degraded: false };
        return allowed ? base : { ...base, retryAfterMs };
    }
}