import { randomUUID } from 'node:crypto';
import type { RateLimitAlgorithm, CompiledScript } from '../core/interfaces';
import type { Decision, LimitPolicy, ScriptResult } from '../core/types';

// Exact count of requests in the trailing window. The member is a unique
// id from the caller (not math.random inside the script) so two requests
// in the same millisecond can't collide on the same sorted-set entry.
const LUA = `
local window = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local member = ARGV[3]

local t = redis.call('TIME')
local now_ms = (tonumber(t[1]) * 1000) + math.floor(tonumber(t[2]) / 1000)

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now_ms - window)
local count = redis.call('ZCARD', KEYS[1])

local allowed = 0
local remaining = 0
if count < limit then
  redis.call('ZADD', KEYS[1], now_ms, member)
  allowed = 1
  remaining = limit - count - 1
end

redis.call('PEXPIRE', KEYS[1], window)

local reset_at = now_ms + window
local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
if oldest[2] then
  reset_at = tonumber(oldest[2]) + window
end

local retry_after = 0
if allowed == 0 then
  retry_after = reset_at - now_ms
  if retry_after < 0 then retry_after = 0 end
end

return { allowed, remaining, retry_after, reset_at }
`;

export class SlidingWindowLogAlgorithm implements RateLimitAlgorithm {
    readonly name = 'sliding-window-log';

    buildScript(fullKey: string, policy: LimitPolicy): CompiledScript {
        const member = `${Date.now()}-${randomUUID()}`;
        return {
            source: LUA,
            keys: [fullKey],
            args: [String(policy.windowMs), String(policy.maxRequests), member],
        };
    }

    interpret(raw: ScriptResult, policy: LimitPolicy, _nowMs: number): Decision {
        const allowed = (raw[0] ?? 0) === 1;
        const remaining = raw[1] ?? 0;
        const retryAfterMs = raw[2] ?? 0;
        const resetAtMs = raw[3] ?? 0;

        const base = { allowed, limit: policy.maxRequests, remaining, resetAtMs, degraded: false };
        return allowed ? base : { ...base, retryAfterMs };
    }
}