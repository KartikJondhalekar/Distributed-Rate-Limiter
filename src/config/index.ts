import { configSchema, type RawConfig } from './schema';
import { ConfigError } from '../core/errors';

export type Config = Readonly<RawConfig>;

let cached: Config | undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
    const parsed = configSchema.safeParse(env);

    if (!parsed.success) {
        // Collect every problem into one message so the operator sees all of
        // them at once instead of fixing one, re-running, hitting the next.
        const details = parsed.error.issues
            .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
            .join('\n');
        throw new ConfigError(
            `Invalid configuration — ${parsed.error.issues.length} problem(s):\n${details}`,
        );
    }

    return Object.freeze({ ...parsed.data });
}

export function getConfig(): Config {
    if (!cached) cached = loadConfig();
    return cached;
}

// Tests call this to re-load under a different env.
export function resetConfigCache(): void {
    cached = undefined;
}