// Burst benchmark. Fires a spike of requests at a SINGLE token-bucket key to
// show the bucket absorbs up to its capacity, then rejects the rest. Expect
// allowed ~= bucketCapacity (plus a few from refill during the run).
//
//   k6 run benchmarks/burst.js
//   BASE_URL=http://localhost:3000 KEY=burst-1 k6 run benchmarks/burst.js
//
// The key is fixed (shared across all VUs) so they contend on one bucket.
// Re-runs reuse the key until its TTL lapses; pass a fresh KEY to reset.
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const allowed = new Counter('rl_allowed');
const limited = new Counter('rl_limited');

const BASE = __ENV.BASE_URL || 'http://localhost:3000';
const KEY = __ENV.KEY || 'burst-shared';
const CAPACITY = 50;

export const options = {
    scenarios: {
        spike: {
            executor: 'shared-iterations',
            vus: 100,
            iterations: 500,
            maxDuration: '10s',
        },
    },
};

export default function () {
    const res = http.post(
        `${BASE}/check`,
        JSON.stringify({
            key: KEY,
            algorithm: 'token-bucket',
            windowMs: 60_000,
            maxRequests: CAPACITY,
            bucketCapacity: CAPACITY,
            refillRatePerSec: 1,
        }),
        { headers: { 'Content-Type': 'application/json' } },
    );
    check(res, { 'status 200': (r) => r.status === 200 });
    const body = res.json();
    if (body && body.allowed) allowed.add(1);
    else limited.add(1);
}

export function handleSummary(data) {
    const a = data.metrics.rl_allowed ? data.metrics.rl_allowed.values.count : 0;
    const l = data.metrics.rl_limited ? data.metrics.rl_limited.values.count : 0;
    return {
        stdout: `\nBurst result: allowed=${a} (≈ capacity ${CAPACITY}), limited=${l}\n\n`,
    };
}