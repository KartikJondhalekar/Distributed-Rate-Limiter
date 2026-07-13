// Sustained-load benchmark against one limiter instance.
// Measures decision throughput and P99 latency as arrival rate ramps.
//
//   k6 run benchmarks/single-instance.js
//   BASE_URL=http://localhost:3000 ALGO=sliding-window-log k6 run benchmarks/single-instance.js
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const allowed = new Counter('rl_allowed');
const limited = new Counter('rl_limited');

const BASE = __ENV.BASE_URL || 'http://localhost:3000';
const ALGO = __ENV.ALGO || 'token-bucket';

export const options = {
    scenarios: {
        steady: {
            executor: 'ramping-arrival-rate',
            startRate: 50,
            timeUnit: '1s',
            preAllocatedVUs: 50,
            maxVUs: 300,
            stages: [
                { target: 200, duration: '15s' },
                { target: 500, duration: '15s' },
                { target: 500, duration: '20s' },
            ],
        },
    },
    thresholds: {
        http_req_duration: ['p(95)<15', 'p(99)<30'],
        http_req_failed: ['rate<0.01'],
        checks: ['rate>0.99'],
    },
};

export default function () {
    const key = `vu-${__VU}`;
    const res = http.post(`${BASE}/check`, JSON.stringify({ key, algorithm: ALGO }), {
        headers: { 'Content-Type': 'application/json' },
    });
    const ok = check(res, { 'status 200': (r) => r.status === 200 });
    if (ok) {
        const body = res.json();
        if (body && body.allowed) allowed.add(1);
        else limited.add(1);
    }
}