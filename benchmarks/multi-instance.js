// Multi-instance benchmark. Point BASE_URL at a load balancer fronting N
// limiter instances that share ONE Redis. A small key pool is hammered from
// all VUs, so the global limit is enforced regardless of which instance
// serves each request — this is the distributed-coordination proof at load.
//
// Bring up multiple instances however you like, e.g.:
//   API_PORT=3000 npm run serve   (instance 1)
//   API_PORT=3001 npm run serve   (instance 2)
//   API_PORT=3002 npm run serve   (instance 3)
// then front them with nginx/HAProxy and:
//   BASE_URL=http://localhost:8080 k6 run benchmarks/multi-instance.js
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const allowed = new Counter('rl_allowed');
const limited = new Counter('rl_limited');

const BASE = __ENV.BASE_URL || 'http://localhost:3000';
const KEYS = ['tenant-a', 'tenant-b', 'tenant-c'];

export const options = {
    scenarios: {
        fanout: {
            executor: 'ramping-arrival-rate',
            startRate: 100,
            timeUnit: '1s',
            preAllocatedVUs: 100,
            maxVUs: 600,
            stages: [
                { target: 500, duration: '15s' },
                { target: 1000, duration: '20s' },
                { target: 1000, duration: '25s' },
            ],
        },
    },
    thresholds: {
        http_req_duration: ['p(95)<25', 'p(99)<60'],
        http_req_failed: ['rate<0.01'],
    },
};

export default function () {
    const key = KEYS[__VU % KEYS.length];
    const res = http.post(
        `${BASE}/check`,
        JSON.stringify({ key, algorithm: 'sliding-window-counter', windowMs: 1000, maxRequests: 200 }),
        { headers: { 'Content-Type': 'application/json' } },
    );
    const ok = check(res, { 'status 200': (r) => r.status === 200 });
    if (ok) {
        const body = res.json();
        if (body && body.allowed) allowed.add(1);
        else limited.add(1);
    }
}