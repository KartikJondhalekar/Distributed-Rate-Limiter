import type { Logger } from '../core/interfaces';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export class ConsoleJsonLogger implements Logger {
    constructor(private readonly level: LogLevel = 'info') { }

    private emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
        if (ORDER[level] < ORDER[this.level]) return;
        const line = JSON.stringify({ level, time: new Date().toISOString(), msg, ...fields });
        // warn/error to stderr so log shippers can split streams.
        if (level === 'warn' || level === 'error') console.error(line);
        else console.log(line);
    }

    debug(msg: string, fields?: Record<string, unknown>): void {
        this.emit('debug', msg, fields);
    }
    info(msg: string, fields?: Record<string, unknown>): void {
        this.emit('info', msg, fields);
    }
    warn(msg: string, fields?: Record<string, unknown>): void {
        this.emit('warn', msg, fields);
    }
    error(msg: string, fields?: Record<string, unknown>): void {
        this.emit('error', msg, fields);
    }
}