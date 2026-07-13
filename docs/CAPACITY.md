# Capacity & Operational Constraints

The exact resources to watch when this limiter scales up, and where the
warning lines sit. Grouped by the component that fails first.

## Redis memory (usually the first ceiling)

Per-client key footprint by algorithm:

| Algorithm | Structure | Bytes/client | Growth |
|---|---|---|---|
| Token bucket | hash: `tokens`, `ts` | ~100 B | constant |
| Sliding window counter | hash: 2–3 window fields | ~150 B | constant |
| Sliding window log | sorted set, one entry per request in window | ~80 B × current count | grows with limit × rate |

Total ≈ (active keys) × (bytes/client). The sliding-window-log route is the
one to watch: a high `maxRequests` on a high-traffic key holds that many
timestamps at once.

- **Bound it:** every key gets a `PEXPIRE`, so idle clients evaporate. Verify TTLs are being set (`redis-cli TTL <key>` should return a positive number).
- **Watch:** `used_memory` vs `maxmemory`, and `DBSIZE` (active key count).
- **Warning line:** `used_memory` approaching `maxmemory`. If Redis is configured with an LRU/`allkeys-*` eviction policy, it can silently evict live limiter keys — which **resets those clients' limits mid-window**. Run the limiter against a Redis whose `maxmemory-policy` is `noeviction` (limiter errors → fail-open/closed, which is at least observable) or a dedicated instance.

## Redis CPU (single-threaded)

Redis executes one command — and one Lua script — at a time.

- Token bucket and counter scripts are **O(1)**. The log script does an **O(N)** trim (`ZREMRANGEBYSCORE`) proportional to entries in the window.
- **Watch:** `redis-cli --latency`, `INFO commandstats`, and the `SLOWLOG`.
- **Warning line:** any limiter script showing up in `SLOWLOG` (default 10ms). A slow script blocks *every* other Redis client, so a hot high-limit log route can degrade the whole instance.

## Connections / sockets

Each app instance opens one multiplexed `ioredis` connection (commands pipeline over it — you do not need a pool for throughput).

- **Watch:** `connected_clients`, `blocked_clients` in `INFO clients`.
- **Warning line:** `connected_clients` approaching Redis `maxclients` (default 10000). With N app instances that's N connections — only a problem at very large fleet sizes or if connections leak (check that shutdown calls `client.quit()`).

## App instance (Node)

The limiter adds exactly one Redis round-trip per request. Locally that's sub-millisecond; the `REDIS_TIMEOUT_MS` budget caps the tail.

- **Watch:** the `rate_limiter_redis_latency_ms` histogram (P99), event-loop lag from `collectDefaultMetrics` (`nodejs_eventloop_lag_seconds`).
- **Warning line:** P99 latency climbing toward `REDIS_TIMEOUT_MS` — Redis is saturating and timeouts (→ degraded decisions) are imminent.

## Degraded state (the one to alert on)

`rate_limiter_degraded_total` counts decisions made while Redis was
unreachable. With the default `fail-open`, a nonzero rate here means the
limiter **is not currently protecting anything**.

- **Warning line:** any sustained increase in `rate_limiter_degraded_total`. This should be zero in steady state; alert on `rate > 0` over a short window.

## Scaling path

1. **Vertical Redis first** — a single node handles tens of thousands of ops/sec comfortably; this covers most deployments.
2. **Redis Cluster** when one node isn't enough. Keys are already hash-tagged (`prefix:{clientKey}`), so all keys for a client land in one slot and stay atomically scriptable.
   - **Warning line:** in Cluster mode, any script touching keys across slots errors (`CROSSSLOT`). Keep every script's keys under one hash tag — the current design does; preserve that if adding multi-tier quotas.