# Distributed Rate Limiter

![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)
![Redis](https://img.shields.io/badge/Redis-7-DC382D?logo=redis&logoColor=white)
![Tests](https://img.shields.io/badge/tests-36%20passing-success)
![License](https://img.shields.io/badge/license-MIT-blue)

A production-grade distributed rate limiter for Node.js APIs. Enforces limits **atomically across many server instances** using Redis Lua scripts, so a client can't bypass a limit by spreading requests across your fleet. Ships as both a drop-in Express middleware and a language-agnostic REST service, with Prometheus metrics, configurable failure behavior, and a k6 load-test suite.

Built in TypeScript with strict typing, dependency injection, and zero global state.

---

## Why

Application-level rate limiting works on a single server but breaks the moment you run more than one instance — each process keeps its own counter, so `N` instances means a client gets roughly `N×` its intended limit. Solving this requires shared state *and* a way to check-and-update that state without a race between the read and the write. This project does that with Redis Lua scripts, which execute atomically and single-threaded on the Redis server: the entire *read → decide → write* sequence is one indivisible operation, eliminating the time-of-check-to-time-of-use race that plagues naive implementations.

---

## Features

- **Three algorithms behind one interface** — Token Bucket (default, burst-friendly), Sliding Window Log (exact), and Sliding Window Counter (O(1) memory), selectable per request.
- **Atomic enforcement** — every decision is a single Redis Lua script; window math uses `redis.call('TIME')` as the sole clock authority, so instances never disagree due to clock skew.
- **Two integration modes** — a drop-in Express `rateLimit()` middleware and a language-agnostic `POST /check` REST oracle.
- **Standard headers** — `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, and `Retry-After`.
- **Semantic error mapping** — structured JSON for `400` (bad request), `429` (rate limited), `500` (internal), `503` (health).
- **Configurable failure posture** — `fail-open` (availability-first) or `fail-closed` (protection-first) when Redis is unreachable, with the degraded state logged and counted.
- **Observability built in** — Prometheus metrics on a dedicated port, plus structured JSON logging.
- **Cluster-ready** — keys are hash-tagged so a client's keys co-locate in one Redis Cluster slot.
- **Tested** — 32 unit tests (mocked dependencies) and 4 integration tests against real Redis via Testcontainers, including a 50-concurrent atomicity proof.

---

## Architecture

```
                        ┌─────────────────┐
   Client requests ───► │  Load Balancer  │  (no sticky sessions —
                        │ / Reverse Proxy │   any instance serves any client)
                        └────────┬────────┘
              ┌──────────────────┼──────────────────┐
              ▼                  ▼                  ▼
       ┌────────────┐    ┌────────────┐    ┌────────────┐
       │ API Inst 1 │    │ API Inst 2 │    │ API Inst N │   (stateless)
       └──────┬─────┘    └──────┬─────┘    └──────┬─────┘
              │                 │                 │
   ┌──────────┴─────────────────┴─────────────────┴──────────┐
   │  Express rateLimit() middleware  ─or─  POST /check       │
   └──────────────────────────┬───────────────────────────────┘
                              ▼
                    ┌───────────────────┐
                    │ Rate Limiter Core │  (algorithm-agnostic orchestrator)
                    └─────────┬─────────┘
                              │  EVALSHA <script>  KEYS=[clientKey]
                              ▼
                    ┌───────────────────┐
                    │   REDIS (atomic)  │  single-threaded Lua:
                    │  TIME → read →    │  Token Bucket / Sliding Window
                    │  decide → write   │  + PEXPIRE self-clean
                    └─────────┬─────────┘
                              ▼
                  Allow (200 / next()) or Reject (429)
                              │
                    ┌───────────────────┐
                    │ Prometheus /metrics│  :9090
                    └───────────────────┘
```

---

## Algorithms

| Algorithm | Accuracy | Burst handling | Memory / client | Best for |
|---|---|---|---|---|
| **Token Bucket** *(default)* | Rate-based | Excellent — absorbs bursts to capacity | ~100 B | General API protection |
| **Sliding Window Log** | Exact | Smooth | Grows with limit × rate | Auth, payments, precision-critical routes |
| **Sliding Window Counter** | ~99% (weighted) | Smooth | ~150 B (O(1)) | High-volume routes needing accuracy at low memory |

Fixed Window and Leaky Bucket were evaluated and rejected — Fixed Window allows up to 2× the limit at a window boundary; Leaky Bucket shapes output rate (good for queueing toward a downstream, wrong for protecting an API from bursts).

---

## Tech Stack

| Layer | Technology |
|---|---|
| Core | TypeScript, Node.js 20+ |
| Distributed state | Redis 7 (Lua scripts, `ioredis`) |
| Config validation | Zod |
| Middleware / API | Express |
| Metrics | Prometheus (`prom-client`) |
| Testing | Jest, ts-jest, Testcontainers |
| Load testing | k6 |

---

## Getting Started

### Prerequisites

- Node.js 20+
- Redis 7 (via Docker, or any local Redis on `localhost:6379`)
- Docker Desktop — required for the integration tests and the bundled `docker-compose.yml`

### Install & run

```bash
git clone https://github.com/yourusername/distributed-rate-limiter
cd distributed-rate-limiter
npm install

# copy the environment template
cp .env.example .env

# start Redis
docker compose up -d

# start the server (API on :3000, metrics on :9090)
npm run serve
```

You should see `{"level":"info","msg":"rate limiter listening","port":3000,...}`.

---

## Deployment (Docker)

The app ships as a container. A multi-stage `Dockerfile` compiles TypeScript in a build stage and runs a slim, **non-root** runtime image; the bundled Compose file can bring up the app **and** Redis together.

```bash
# Full stack (app + Redis) — API on :3000, metrics on :9090
docker compose --profile full up --build -d

curl -s http://localhost:3000/health

# Tear it down
docker compose --profile full down
```

Without the `full` profile, `docker compose up -d` starts **only Redis** — the workflow for developing locally with `npm run serve` against a containerized Redis.

To build and run the image directly:

```bash
docker build -t distributed-rate-limiter .
docker run --rm -p 3000:3000 -p 9090:9090 \
  -e REDIS_URL=redis://host.docker.internal:6379 \
  distributed-rate-limiter
```

The image runs as a non-root user, uses `tini` as PID 1 so `SIGTERM` triggers graceful shutdown, and defines a `HEALTHCHECK` against `/health`. Configuration is supplied entirely through environment variables — no secrets are baked into the image.

---

## Configuration

All configuration comes from environment variables, validated at startup — the process refuses to boot on invalid config rather than failing later. See `.env.example`.

| Variable | Default | Description |
|---|---|---|
| `REDIS_URL` | *(required)* | Redis connection string, e.g. `redis://localhost:6379` |
| `REDIS_KEY_PREFIX` | `rl` | Namespace prefix for all keys |
| `REDIS_TIMEOUT_MS` | `50` | Per-operation timeout before a request is treated as a Redis failure |
| `DEFAULT_ALGORITHM` | `token-bucket` | `token-bucket` \| `sliding-window-log` \| `sliding-window-counter` |
| `DEFAULT_WINDOW_MS` | `60000` | Window length in milliseconds |
| `DEFAULT_MAX_REQUESTS` | `100` | Requests allowed per window |
| `DEFAULT_BUCKET_CAPACITY` | *(optional)* | Token-bucket burst ceiling; derived from `DEFAULT_MAX_REQUESTS` if unset |
| `DEFAULT_REFILL_RATE_PER_SEC` | *(optional)* | Token refill rate; derived from limit ÷ window if unset |
| `FAILURE_MODE` | `fail-open` | `fail-open` (allow on Redis outage) or `fail-closed` (reject) |
| `API_PORT` | `3000` | HTTP API port |
| `METRICS_PORT` | `9090` | Prometheus metrics port (must differ from `API_PORT`) |

For Token Bucket, leave the two optional tuning fields unset to get an intuitive limit driven by `DEFAULT_MAX_REQUESTS`. Set them only when you want to allow bursts *above* the sustained rate.

---

## Usage

### As Express middleware

```ts
import express from 'express';
import { Redis } from 'ioredis';
import { buildRateLimiter, rateLimit, loadConfig } from 'distributed-rate-limiter';
import type { Logger } from 'distributed-rate-limiter';

const config = loadConfig();
const redis = new Redis(config.REDIS_URL);

// Supply any logger implementing the Logger interface.
const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

const limiter = buildRateLimiter(config, redis, logger);

const app = express();

// Guard a route group; key by client IP (the default), or pass your own keyGenerator.
app.use(
  '/api',
  rateLimit({
    limiter,
    keyGenerator: (req) => req.ip ?? 'anonymous',
    policyOverride: { maxRequests: 20, windowMs: 10_000 },
  }),
);

app.get('/api/data', (_req, res) => res.json({ ok: true }));
app.listen(3000);
```

### As a REST service

Run the server (`npm run serve`) and call it from any language.

```bash
# Ask the oracle whether a client may proceed
curl -s -X POST http://localhost:3000/check \
  -H "Content-Type: application/json" \
  -d '{"key":"user-42","maxRequests":3,"windowMs":10000}'
# → {"allowed":true,"limit":3,"remaining":2,"resetAt":"...","retryAfterMs":0,"degraded":false}

# Health (503 if Redis is unreachable)
curl -s http://localhost:3000/health
# → {"status":"ok","redis":true}
```

> **Windows PowerShell note:** PowerShell mangles inline JSON passed to `curl.exe`. Use `Invoke-RestMethod -Method Post -Uri http://localhost:3000/check -ContentType 'application/json' -Body '{"key":"user-42"}'` or write the body to a file and pass `-d "@body.json"`.

---

## HTTP Reference

| Method | Path | Port | Description |
|---|---|---|---|
| `POST` | `/check` | 3000 | Evaluate a key; returns the verdict as `200` JSON (caller enforces) |
| `GET` | `/health` | 3000 | Liveness + Redis reachability (`200` / `503`) |
| `GET` | `/metrics` | 9090 | Prometheus exposition format |

Every response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset`. A `429` additionally carries `Retry-After` and a structured body:

```json
{
  "error": {
    "type": "rate_limit_exceeded",
    "message": "Too many requests",
    "limit": 5,
    "remaining": 0,
    "retryAfterMs": 1993,
    "resetAt": "2026-01-01T00:00:00.000Z",
    "degraded": false
  }
}
```

---

## Observability

Prometheus metrics are exposed on `METRICS_PORT` (default `9090`) at `/metrics`, alongside standard Node process metrics.

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `rate_limiter_requests_total` | counter | `algorithm` | Total checks evaluated |
| `rate_limiter_hits_total` | counter | `algorithm` | Requests rejected |
| `rate_limiter_degraded_total` | counter | `mode` | Decisions made while Redis was unreachable |
| `rate_limiter_redis_latency_ms` | histogram | `algorithm` | Latency of the atomic store evaluation |

`rate_limiter_degraded_total` is the one to alert on — with `fail-open`, any sustained increase means the limiter is not currently protecting anything.

---

## Testing

```bash
# Unit tests — fast, no Docker (mocked dependencies)
npm test

# With coverage
npm run test:coverage

# Integration tests — spins up a real Redis via Testcontainers (needs Docker)
npm run test:integration
```

The integration suite proves what mocks can't: exact boundary enforcement, temporal recovery (bucket refill over time), and — most importantly — **atomicity**, firing 50 concurrent requests at a limit of 10 and asserting exactly 10 are admitted.

---

## Load Testing

Requires [k6](https://k6.io) (`winget install GrafanaLabs.k6`, `brew install k6`, or `choco install k6`). Start the server first.

```bash
npm run load:single   # sustained ramp 50→500 req/s, single instance
npm run load:multi    # cross-instance coordination (point BASE_URL at a load balancer)
npm run load:burst    # spike 500 requests at one token bucket
```

The burst test demonstrates the core guarantee at the HTTP layer: a 500-request spike from 100 concurrent VUs against one token bucket of capacity 50 admits **exactly 50**, rejecting the rest — burst absorption and atomicity, verified end to end.

---

## Project Structure

```
src/
├── config/           # Zod schema + immutable config loader
├── core/             # types, interfaces, errors, orchestrator, clock, key builder
├── algorithms/       # token bucket, sliding window log, sliding window counter
├── store/            # Redis store: EVALSHA + timeout + error classification
├── middleware/       # Express rateLimit() + key generators + headers
├── api/              # POST /check + GET /health router
├── observability/    # JSON logger + Prometheus metrics + metrics server
├── factory.ts        # composition root
├── server.ts         # HTTP entry point
└── index.ts          # public library exports
tests/
├── unit/             # table-driven, mocked
└── integration/      # Testcontainers (real Redis)
benchmarks/           # k6 load scripts
docs/CAPACITY.md      # production capacity & scaling checklist
Dockerfile            # multi-stage build → slim non-root runtime
docker-compose.yml    # Redis (default) + app (--profile full)
```

---

## Design Notes

- **Why Lua over `MULTI`/`EXEC` or `WATCH`?** Redis transactions can't branch (no conditional check-then-write), and optimistic `WATCH` locking causes retry storms under exactly the high-contention conditions this tool exists for. A Lua script runs atomically with full conditional logic and no client round-trips mid-decision.
- **Why Redis `TIME` instead of client timestamps?** Different app hosts drift. Sourcing time from the single Redis server makes window boundaries deterministic across the whole fleet.
- **Why fail-open by default?** An availability-first posture avoids `429`-ing every client during a Redis outage. Switch to `fail-closed` per deployment for auth or payment routes where over-admitting is the greater risk. A genuine code error (a Lua bug) is deliberately *not* treated as an outage — it surfaces loudly rather than silently opening the gate.

See [`docs/CAPACITY.md`](docs/CAPACITY.md) for memory, CPU, connection, and scaling constraints.

---

## Roadmap

- Leaky Bucket algorithm variant
- Per-user quota tiers (free / pro / enterprise)
- Explicit Redis Cluster deployment (hash-tags already in place)
- Grafana dashboard template for the emitted metrics
- Publish to npm

---

## License

MIT