import type { RateLimitAlgorithm, CompiledScript } from '../core/interfaces';
import type { Decision, LimitPolicy, ScriptResult } from '../core/types';

// Approximates the sliding window with two fixed counters: the current
// window plus a weighted fraction of the previous one. O(1) memory, ~99%
// accurate. Stale window fields are pruned each call.
const LUA = `
local window = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])

local t = redis.call('TIME')
local now_ms = (tonumber(t[1]) * 1000) + math.floor(tonumber(t[2]) / 1000)

local curr_win = math.floor(now_ms / window)
local prev_win = curr_win - 1
local pos = now_ms % window
local weight = (window - pos) / window

local vals = redis.call('HMGET', KEYS[1], tostring(curr_win), tostring(prev_win))
local curr = tonumber(vals[1]) or 0
local prev = tonumber(vals[2]) or 0

local estimated = (prev * weight) + curr

local allowed = 0
local remaining = 0
if estimated < limit then
  allowed = 1
  curr = curr + 1
  redis.call('HSET', KEYS[1], tostring(curr_win), curr)
  remaining = math.floor(limit - estimated - 1)
  if remaining < 0 then remaining = 0 end
end

local fields = redis.call('HKEYS', KEYS[1])
for i = 1, #fields do
  local w = tonumber(fields[i])
  if w and w < prev_win then
    redis.call('HDEL', KEYS[1], fields[i])
  end
end

redis.call('PEXPIRE', KEYS[1], window * 2)

local reset_at = (curr_win + 1) * window
local retry_after = 0
if allowed == 0 then
  retry_after = reset_at - now_ms
  if retry_after < 0 then retry_after = 0 end
end

return { allowed, remaining, retry_after, reset_at }
`;

export class SlidingWindowCounterAlgorithm implements RateLimitAlgorithm {
    readonly name = 'sliding-window-counter';

    buildScript(fullKey: string, policy: LimitPolicy): CompiledScript {
        return {
            source: LUA,
            keys: [fullKey],
            args: [String(policy.windowMs), String(policy.maxRequests)],
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