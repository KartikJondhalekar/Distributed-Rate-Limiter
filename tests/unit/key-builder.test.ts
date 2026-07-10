import { HashTagKeyBuilder } from '../../src/core/key-builder';

describe('HashTagKeyBuilder', () => {
    test('wraps the client key in a hash tag with the prefix', () => {
        expect(new HashTagKeyBuilder('rl').build('user-1')).toBe('rl:{user-1}');
    });

    test('different prefixes produce distinct keys for the same client', () => {
        const a = new HashTagKeyBuilder('a').build('x');
        const b = new HashTagKeyBuilder('b').build('x');
        expect(a).not.toBe(b);
    });
});