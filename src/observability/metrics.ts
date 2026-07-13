import client from 'prom-client';
import type { MetricsSink } from '../core/interfaces';

// Maps the orchestrator's name-keyed MetricsSink calls onto concretely-typed
// prom-client instruments. Unknown names are ignored, so instrumentation
// points can be added in the core without breaking this adapter.
export class PrometheusMetrics implements MetricsSink {
    readonly registry: client.Registry;
    private readonly counters: Map<string, client.Counter<string>>;
    private readonly histograms: Map<string, client.Histogram<string>>;

    constructor() {
        this.registry = new client.Registry();
        client.collectDefaultMetrics({ register: this.registry });

        const requests = new client.Counter({
            name: 'rate_limiter_requests_total',
            help: 'Total rate-limit checks evaluated',
            labelNames: ['algorithm'],
            registers: [this.registry],
        });
        const hits = new client.Counter({
            name: 'rate_limiter_hits_total',
            help: 'Total requests rejected by the limiter',
            labelNames: ['algorithm'],
            registers: [this.registry],
        });
        const degraded = new client.Counter({
            name: 'rate_limiter_degraded_total',
            help: 'Decisions made in a degraded (store-unavailable) state',
            labelNames: ['mode'],
            registers: [this.registry],
        });
        const latency = new client.Histogram({
            name: 'rate_limiter_redis_latency_ms',
            help: 'Latency of the atomic store evaluation, in milliseconds',
            labelNames: ['algorithm'],
            buckets: [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000],
            registers: [this.registry],
        });

        this.counters = new Map<string, client.Counter<string>>([
            ['rate_limiter_requests_total', requests],
            ['rate_limiter_hits_total', hits],
            ['rate_limiter_degraded_total', degraded],
        ]);
        this.histograms = new Map<string, client.Histogram<string>>([
            ['rate_limiter_redis_latency_ms', latency],
        ]);
    }

    incrCounter(name: string, labels?: Record<string, string>, value?: number): void {
        const counter = this.counters.get(name);
        if (counter) counter.inc(labels ?? {}, value ?? 1);
    }

    observeHistogram(name: string, value: number, labels?: Record<string, string>): void {
        const histogram = this.histograms.get(name);
        if (histogram) histogram.observe(labels ?? {}, value);
    }

    async metrics(): Promise<string> {
        return this.registry.metrics();
    }

    get contentType(): string {
        return this.registry.contentType;
    }
}