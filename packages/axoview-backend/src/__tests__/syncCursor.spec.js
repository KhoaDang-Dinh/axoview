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
