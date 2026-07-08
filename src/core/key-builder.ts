import type { KeyBuilder } from './interfaces';

// Wrapping the client id in {braces} makes it the Cluster hash-tag, so any
// future per-client keys (e.g. :minute, :hour tiers) land in the same slot
// and can be touched atomically by one script.
export class HashTagKeyBuilder implements KeyBuilder {
    constructor(private readonly prefix: string) { }

    build(clientKey: string): string {
        return `${this.prefix}:{${clientKey}}`;
    }
}