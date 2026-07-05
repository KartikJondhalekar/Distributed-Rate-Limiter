import 'dotenv/config';
import { loadConfig } from './config';
import { RateLimiterError } from './core/errors';

function redact(cfg: Record<string, unknown>): Record<string, unknown> {
  const clone: Record<string, unknown> = { ...cfg };
  if (typeof clone.REDIS_URL === 'string') {
    // Strip any user:pass@ before it hits stdout.
    clone.REDIS_URL = clone.REDIS_URL.replace(/(:\/\/)([^@]*@)/, '$1***@');
  }
  return clone;
}

try {
  const config = loadConfig();
  console.log(
    JSON.stringify(
      { level: 'info', msg: 'configuration loaded and validated', config: redact(config) },
      null,
      2,
    ),
  );
} catch (err) {
  const message = err instanceof RateLimiterError ? err.message : String(err);
  console.error(
    JSON.stringify({ level: 'error', msg: 'configuration failed validation', error: message }),
  );
  process.exitCode = 1;
}