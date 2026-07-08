import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { CompiledScript, Logger, RateLimitStore } from '../core/interfaces';
import type { ScriptResult } from '../core/types';
import { ScriptExecutionError, StoreUnavailableError } from '../core/errors';

export interface RedisStoreDeps {
    readonly client: Redis;
    readonly timeoutMs: number;
    readonly logger: Logger;
}

function isReplyError(err: unknown): boolean {
    return err instanceof Error && err.name === 'ReplyError';
}

function isNoScript(err: unknown): boolean {
    return err instanceof Error && err.message.includes('NOSCRIPT');
}

export class RedisRateLimitStore implements RateLimitStore {
    private readonly shaCache = new Map<string, string>();

    constructor(private readonly deps: RedisStoreDeps) { }

    async evaluate(script: CompiledScript): Promise<ScriptResult> {
        try {
            return await this.withTimeout(this.run(script));
        } catch (err) {
            // A Lua-level error is our bug, not an outage — surface it so it can't
            // silently trip the fail-open path and mask a broken deploy.
            if (isReplyError(err) && !isNoScript(err)) {
                throw new ScriptExecutionError(`lua error: ${(err as Error).message}`, { cause: err });
            }
            // Timeout or connection failure — the orchestrator applies the failure mode.
            this.deps.logger.warn('store unavailable', { error: (err as Error).message });
            throw new StoreUnavailableError((err as Error).message, { cause: err });
        }
    }

    async ping(): Promise<boolean> {
        try {
            const reply = await this.withTimeout(this.deps.client.ping());
            return reply === 'PONG';
        } catch {
            return false;
        }
    }

    private async run(script: CompiledScript): Promise<ScriptResult> {
        const sha = this.shaFor(script.source);
        const numKeys = script.keys.length;
        const argv = [...script.keys, ...script.args];

        try {
            return this.coerce(await this.deps.client.evalsha(sha, numKeys, ...argv));
        } catch (err) {
            // First run on a fresh Redis: the script isn't cached yet. Ship the
            // source once; Redis caches it under the same sha for next time.
            if (isNoScript(err)) {
                return this.coerce(await this.deps.client.eval(script.source, numKeys, ...argv));
            }
            throw err;
        }
    }

    private shaFor(source: string): string {
        let sha = this.shaCache.get(source);
        if (!sha) {
            sha = createHash('sha1').update(source).digest('hex');
            this.shaCache.set(source, sha);
        }
        return sha;
    }

    private coerce(reply: unknown): ScriptResult {
        if (!Array.isArray(reply)) {
            throw new ScriptExecutionError(`expected array reply, got ${typeof reply}`);
        }
        return reply.map((v) => Number(v));
    }

    private withTimeout<T>(op: Promise<T>): Promise<T> {
        const ms = this.deps.timeoutMs;
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error(`redis operation timed out after ${ms}ms`)),
                ms,
            );
            op.then(
                (value) => {
                    clearTimeout(timer);
                    resolve(value);
                },
                (err) => {
                    clearTimeout(timer);
                    reject(err);
                },
            );
        });
    }
}