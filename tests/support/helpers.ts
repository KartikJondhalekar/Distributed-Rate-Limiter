import type {
    Clock,
    CompiledScript,
    Logger,
    MetricsSink,
    RateLimitStore,
} from '../../src/core/interfaces';
import type { ScriptResult } from '../../src/core/types';

export class FakeClock implements Clock {
    constructor(private t = 1_000_000) { }
    nowMs(): number {
        return this.t;
    }
    set(t: number): void {
        this.t = t;
    }
}

export const noopLogger: Logger = {
    debug() { },
    info() { },
    warn() { },
    error() { },
};

export class RecordingMetrics implements MetricsSink {
    readonly counters: Array<{ name: string; labels?: Record<string, string> }> = [];
    readonly histograms: Array<{ name: string; value: number }> = [];

    incrCounter(name: string, labels?: Record<string, string>): void {
        this.counters.push(labels ? { name, labels } : { name });
    }
    observeHistogram(name: string, value: number): void {
        this.histograms.push({ name, value });
    }
}

export class FakeStore implements RateLimitStore {
    lastScript?: CompiledScript;
    constructor(private readonly behavior: () => Promise<ScriptResult>) { }

    async evaluate(script: CompiledScript): Promise<ScriptResult> {
        this.lastScript = script;
        return this.behavior();
    }
    async ping(): Promise<boolean> {
        return true;
    }
}