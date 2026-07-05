export class RateLimiterError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = new.target.name;
        // Needed for `instanceof` to work when compiling below ES2015.
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

// Config didn't validate at startup.
export class ConfigError extends RateLimiterError { }

// Redis is down or timed out. Caller decides fail-open vs fail-closed.
export class StoreUnavailableError extends RateLimiterError { }

// Script ran but returned something we didn't expect.
export class ScriptExecutionError extends RateLimiterError { }