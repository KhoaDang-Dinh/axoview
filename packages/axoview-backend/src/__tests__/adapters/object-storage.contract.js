/**
 * Shared behavioral contract for ObjectStorage implementations.
 *
 * Keep provider-specific tests separate. A future S3 implementation should run
 * this same contract against an isolated test bucket/prefix.
 */
export function runObjectStorageContract({ name, createStore }) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  describe(`ObjectStorage contract: ${name}`, () => {
    test('missing object reads as null', async () => {
      const store = await createStore();
      expect(await store.get('objects/missing')).toBeNull();
    });

    test('round-trips opaque bytes', async () => {
      const store = await createStore();
      const payload = encoder.encode('not necessarily json');
      await store.put('objects/a', payload);

      const got = await store.get('objects/a');
      expect(got).toBeInstanceOf(Uint8Array);
      expect(decoder.decode(got)).toBe('not necessarily json');
    });

    test('put replaces an existing object', async () => {
      const store = await createStore();
      await store.put('objects/a', encoder.encode('v1'));
      await store.put('objects/a', encoder.encode('v2'));

      expect(decoder.decode(await store.get('objects/a'))).toBe('v2');
    });

    test('delete is idempotent', async () => {
      const store = await createStore();
      await store.put('objects/a', encoder.encode('x'));
      await store.delete('objects/a');
      await expect(store.delete('objects/a')).resolves.toBeUndefined();
      expect(await store.get('objects/a')).toBeNull();
    });

    test('putIfAbsent creates once: later calls leave the first value and say so', async () => {
      const store = await createStore();
      expect(await store.putIfAbsent('objects/once', encoder.encode('first'))).toBe(true);
      expect(await store.putIfAbsent('objects/once', encoder.encode('second'))).toBe(false);
      expect(decoder.decode(await store.get('objects/once'))).toBe('first');
      // A deleted object can be created again.
      await store.delete('objects/once');
      expect(await store.putIfAbsent('objects/once', encoder.encode('third'))).toBe(true);
    });

    test('putIfAbsent: of many concurrent calls for one key, exactly one wins', async () => {
      const store = await createStore();
      const results = await Promise.all(
        Array.from({ length: 25 }, (_, i) => store.putIfAbsent('objects/race', encoder.encode(`writer-${i}`)))
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(decoder.decode(await store.get('objects/race'))).toBe(`writer-${results.indexOf(true)}`);
    });

    test('list returns keys under the requested prefix', async () => {
      const store = await createStore();
      await store.put('objects/a', encoder.encode('a'));
      await store.put('objects/b', encoder.encode('b'));

      expect((await store.list('objects')).sort()).toEqual([
        'objects/a',
        'objects/b'
      ]);
    });
  });
}
