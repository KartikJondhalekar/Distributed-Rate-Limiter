import type { Clock } from './interfaces';

export class SystemClock implements Clock {
    nowMs(): number {
        return Date.now();
    }
}