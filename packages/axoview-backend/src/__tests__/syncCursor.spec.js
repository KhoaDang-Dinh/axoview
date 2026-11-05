/**
 * Realtime multi-device sync — the change cursor (src/syncCursor.js): what a
 * write tells the other devices, which event a stream sends, and both stores.
 */
import {
  createDynamoSyncCursor,
  createMemorySyncCursor,
  describeChange,
  nextSyncEvent,
  sseFrame
} from '../syncCursor.js';

describe('describeChange', () => {
  const result = (etag, body) => ({ status: 200, headers: etag ? { ETag: etag } : {}, body });

  test('a diagram save carries its new version', () => {
    expect(describeChange({ method: 'PUT', route: '/api/diagrams/:id', params: { id: 'd1' }, result: result('"7"') }))
      .toEqual({ kind: 'diagram', action: 'save', id: 'd1', version: 7 });
  });

  test('a create takes the id from the response body', () => {
    expect(describeChange({ method: 'POST', route: '/api/diagrams', result: result('"1"', { id: 'new1' }) }))
      .toEqual({ kind: 'diagram', action: 'create', id: 'new1', version: 1 });
  });

  test('a weak (unversioned) ETag is not a version', () => {
    expect(describeChange({ method: 'PUT', route: '/api/diagrams/:id', params: { id: 'd1' }, result: result('W/"31-abc"') }).version)
      .toBeUndefined();
  });

  test('a rename and a trash or restore say so', () => {
    expect(describeChange({ method: 'PATCH', route: '/api/diagrams/:id', params: { id: 'd1' }, body: { name: 'New' }, result: result() }))
      .toMatchObject({ action: 'update', name: 'New' });
    expect(describeChange({ method: 'PATCH', route: '/api/diagrams/:id', params: { id: 'd1' }, body: { deletedAt: '2026-10-21T00:00:00Z' }, result: result() }))
      .toMatchObject({ action: 'update', deleted: true });
    expect(describeChange({ method: 'PATCH', route: '/api/diagrams/:id', params: { id: 'd1' }, body: { deletedAt: null }, result: result() }))
      .toMatchObject({ action: 'update', deleted: false });
  });

  test('folders and the tree layout', () => {
    expect(describeChange({ method: 'DELETE', route: '/api/folders/:id', params: { id: 'f1' }, result: result() }))
      .toEqual({ kind: 'folder', action: 'delete', id: 'f1' });
    expect(describeChange({ method: 'PUT', route: '/api/tree-manifest', result: result() }))
      .toEqual({ kind: 'tree', action: 'save', id: undefined });
  });

  test('anything else changes nothing other devices show', () => {
    expect(describeChange({ method: 'POST', route: '/api/diagrams/:id/share', params: { id: 'd1' }, result: result() })).toBeNull();
  });
});

describe('nextSyncEvent', () => {
  const change = { kind: 'diagram', action: 'save', id: 'd1' };

  test('no event while nothing changed, or before the stream has a position', () => {
    expect(nextSyncEvent(4, { seq: 4, change })).toBeNull();
    expect(nextSyncEvent(null, { seq: 4, change })).toBeNull();
  });

  test('exactly one new change: that change', () => {
    expect(nextSyncEvent(4, { seq: 5, change })).toEqual({ event: 'change', seq: 5, data: { seq: 5, ...change } });
  });

  test('missed changes, or a sequence that went backwards: resync', () => {
    expect(nextSyncEvent(4, { seq: 7, change }).data).toEqual({ seq: 7, kind: 'resync' });
    expect(nextSyncEvent(40, { seq: 2, change }).data).toEqual({ seq: 2, kind: 'resync' });
  });

  test('frames are well-formed SSE', () => {
    expect(sseFrame('change', 5, { a: 1 })).toBe('id: 5\nevent: change\ndata: {"a":1}\n\n');
  });
});

describe('memory cursor (self-host)', () => {
  test('bump advances the sequence per workspace and wakes a waiting stream at once', async () => {
    const cursor = createMemorySyncCursor();
    const started = Date.now();
    const waiting = cursor.wait('w1', 10_000);
    await cursor.bump('w1', { kind: 'tree', action: 'save' });
    await waiting;
    expect(Date.now() - started).toBeLessThan(1000);
    expect(await cursor.read('w1')).toEqual({ seq: 1, change: { kind: 'tree', action: 'save' } });
    expect(await cursor.read('w2')).toEqual({ seq: 0, change: null });
  });
});

describe('DynamoDB cursor', () => {
  test('bump is one atomic UpdateItem on the workspace SYNC item; read is a GetItem', async () => {
    const sent = [];
    const ddbClient = {
      send: async (command) => {
        sent.push(command);
        if (command.constructor.name === 'UpdateCommand') return { Attributes: { seq: 12 } };
        return { Item: { seq: 12, change: { kind: 'diagram' } } };
      }
    };
    const cursor = createDynamoSyncCursor({ tableName: 'axoview-test', ddbClient });
    expect(await cursor.bump('sub-1', { kind: 'diagram' })).toBe(12);
    expect(await cursor.read('sub-1')).toEqual({ seq: 12, change: { kind: 'diagram' } });

    const [update, get] = sent;
    expect(update.constructor.name).toBe('UpdateCommand');
    expect(update.input).toMatchObject({
      TableName: 'axoview-test',
      Key: { PK: 'WORKSPACE#sub-1', SK: 'SYNC' },
      UpdateExpression: 'SET #change = :change ADD #seq :one'
    });
    expect(get.constructor.name).toBe('GetCommand');
    expect(get.input.Key).toEqual({ PK: 'WORKSPACE#sub-1', SK: 'SYNC' });
  });
});

describe('streams: what a stream sees between polls', () => {
  test('a stream at seq N gets each change exactly once, in order, then nothing', () => {
    let last = 0;
    const seen = [];
    for (const current of [
      { seq: 1, change: { kind: 'diagram', action: 'create', id: 'd1' } },
      { seq: 1, change: { kind: 'diagram', action: 'create', id: 'd1' } },
      { seq: 2, change: { kind: 'diagram', action: 'save', id: 'd1', version: 2 } }
    ]) {
      const event = nextSyncEvent(last, current);
      if (event) {
        seen.push(event.data);
        last = event.seq;
      }
    }
    expect(seen).toEqual([
      { seq: 1, kind: 'diagram', action: 'create', id: 'd1' },
      { seq: 2, kind: 'diagram', action: 'save', id: 'd1', version: 2 }
    ]);
    expect(nextSyncEvent(last, { seq: 2, change: { kind: 'diagram' } })).toBeNull();
  });

  test('a one-step advance without a recorded change is a resync, not an empty change', () => {
    expect(nextSyncEvent(3, { seq: 4, change: null })).toEqual({ event: 'change', seq: 4, data: { seq: 4, kind: 'resync' } });
  });

  test('a frame carries the sequence as its id, so a reconnect resumes there', () => {
    const frame = sseFrame('change', 42, { seq: 42, kind: 'tree', action: 'save' });
    expect(frame.split('\n')[0]).toBe('id: 42');
    expect(frame.endsWith('\n\n')).toBe(true);
    // Data is one JSON line: a name with a newline cannot split the frame.
    const named = sseFrame('change', 1, { seq: 1, kind: 'diagram', action: 'update', name: 'a\nb' });
    expect(named.split('\n').filter((line) => line.startsWith('data: '))).toHaveLength(1);
  });
});

describe('memory cursor: one process, streams woken at once', () => {
  test('a write in another workspace does not wake this stream', async () => {
    const cursor = createMemorySyncCursor();
    let woke = false;
    const waiting = cursor.wait('alice', 300).then(() => { woke = true; });
    await cursor.bump('bob', { kind: 'tree', action: 'save' });
    await new Promise((r) => setTimeout(r, 50));
    expect(woke).toBe(false);
    await waiting;
    expect(await cursor.read('alice')).toEqual({ seq: 0, change: null });
    expect((await cursor.read('bob')).seq).toBe(1);
  });

  test('wait ends at its timeout when nothing changes', async () => {
    const cursor = createMemorySyncCursor();
    const started = Date.now();
    await cursor.wait('w1', 120);
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  });

  test('one write wakes every stream of the workspace, also after many expired waits', async () => {
    const cursor = createMemorySyncCursor();
    const waits = [cursor.wait('w1', 10_000), cursor.wait('w1', 10_000), cursor.wait('w1', 10_000)];
    const started = Date.now();
    await cursor.bump('w1', { kind: 'folder', action: 'create', id: 'f1' });
    await Promise.all(waits);
    expect(Date.now() - started).toBeLessThan(1000);
    // Expired waits unsubscribe; a later wait is still woken by the next write.
    for (let i = 0; i < 50; i++) await cursor.wait('idle', 1);
    const late = cursor.wait('idle', 10_000);
    await cursor.bump('idle', { kind: 'tree', action: 'save' });
    await late;
    expect((await cursor.read('idle')).seq).toBe(1);
  });

  test('the latest change wins the slot; the sequence counts every write', async () => {
    const cursor = createMemorySyncCursor();
    expect(await cursor.bump('w1', { kind: 'diagram', action: 'save', id: 'a' })).toBe(1);
    expect(await cursor.bump('w1', { kind: 'diagram', action: 'save', id: 'b' })).toBe(2);
    expect(await cursor.read('w1')).toEqual({ seq: 2, change: { kind: 'diagram', action: 'save', id: 'b' } });
  });
});

describe('DynamoDB cursor: shared by every API pod, polled', () => {
  test('a workspace never written reads as sequence 0 with no change', async () => {
    const cursor = createDynamoSyncCursor({ tableName: 't', ddbClient: { send: async () => ({}) } });
    expect(await cursor.read('new-user')).toEqual({ seq: 0, change: null });
  });

  test('workspaces are separate items', async () => {
    const keys = [];
    const ddbClient = { send: async (command) => { keys.push(command.input.Key.PK); return { Attributes: { seq: 1 } }; } };
    const cursor = createDynamoSyncCursor({ tableName: 't', ddbClient });
    await cursor.bump('alice', { kind: 'tree' });
    await cursor.bump('bob', { kind: 'tree' });
    expect(keys).toEqual(['WORKSPACE#alice', 'WORKSPACE#bob']);
  });

  test('wait is a plain poll interval: no DynamoDB call while waiting', async () => {
    let calls = 0;
    const cursor = createDynamoSyncCursor({ tableName: 't', ddbClient: { send: async () => { calls += 1; return {}; } } });
    const started = Date.now();
    await cursor.wait('w1', 120);
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    expect(calls).toBe(0);
  });

  test('a DynamoDB error reaches the caller (the stream logs it and ends; the client reconnects)', async () => {
    const cursor = createDynamoSyncCursor({
      tableName: 't',
      ddbClient: { send: async () => { throw Object.assign(new Error('throttled'), { name: 'ProvisionedThroughputExceededException' }); } }
    });
    await expect(cursor.read('w1')).rejects.toThrow('throttled');
  });

  test('a table is required', () => {
    expect(() => createDynamoSyncCursor({ ddbClient: { send: async () => ({}) } })).toThrow(/table/);
  });
});
