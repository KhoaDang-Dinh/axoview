import * as Y from 'yjs';
import { createHash } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { seedModel, patchModel, readModel } from '@axoview/collaboration';
import * as routes from './routes.js';

const encode = bytes => Buffer.from(bytes).toString('base64');
const decode = text => new Uint8Array(Buffer.from(text, 'base64'));
const error = (status, message) => Object.assign(new Error(message), { status, body: { error: message } });
const logKey = seq => `UPDATE#${String(seq).padStart(16, '0')}`;
export const MAX_UPDATE_BYTES = 4 * 1024 * 1024;

export function createJournal({ tableName, region, ddbClient }) {
  const ddb = ddbClient || tableName && DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  const memory = new Map();
  const locks = new Map();
  const journalKey = room => `collaboration-journal/${createHash('sha256').update(room).digest('hex')}`;
  const localRead = async (room, adapter) => {
    if (!adapter) return memory.get(room) || { seq: 0, rows: [] };
    const bytes = await adapter.get(journalKey(room));
    return bytes ? JSON.parse(new TextDecoder().decode(bytes)) : { seq: 0, rows: [] };
  };
  const localWrite = async (room, adapter, value) => {
    if (adapter) await adapter.put(journalKey(room), new TextEncoder().encode(JSON.stringify(value)));
    else memory.set(room, value);
  };
  const locked = async (room, work) => {
    const prior = locks.get(room) || Promise.resolve();
    const run = prior.catch(() => {}).then(work); locks.set(room, run);
    try { return await run; } finally { if (locks.get(room) === run) locks.delete(room); }
  };
  return {
    async append(room, update, adapter) {
      if (!ddb) return locked(room, async () => {
        const state = await localRead(room, adapter);
        const seq = state.seq + 1;
        await localWrite(room, adapter, { seq, rows: [...state.rows, { seq, update }] });
        return seq;
      });
      const hash = createHash('sha256').update(update).digest('hex');
      let payload = { update };
      if (update.length > 192 * 1024) {
        if (!adapter) throw error(413, 'Object storage is required for large updates');
        const objectKey = `collaboration-updates/${hash}`;
        await adapter.putIfAbsent(objectKey, new TextEncoder().encode(update));
        payload = { objectKey };
      }
      for (let attempt = 0; attempt < 12; attempt++) {
        const head = await ddb.send(new GetCommand({ TableName: tableName, Key: { PK: room, SK: 'HEAD' }, ConsistentRead: true }));
        const seq = Number(head.Item?.seq || 0) + 1;
        try {
          await ddb.send(new TransactWriteCommand({ TransactItems: [
            { Put: { TableName: tableName, Item: { PK: room, SK: 'HEAD', seq },
              ConditionExpression: 'attribute_not_exists(#seq) OR #seq = :previous',
              ExpressionAttributeNames: { '#seq': 'seq' }, ExpressionAttributeValues: { ':previous': seq - 1 } } },
            { Put: { TableName: tableName, Item: { PK: room, SK: logKey(seq), seq, ...payload } } },
            { Put: { TableName: tableName, Item: { PK: room, SK: `DEDUP#${hash}`, seq, expiresAt: Math.floor(Date.now() / 1000) + 86400 },
              ConditionExpression: 'attribute_not_exists(PK)' } }
          ] }));
          return seq;
        } catch (err) {
          if (err.name !== 'TransactionCanceledException') throw err;
          const prior = await ddb.send(new GetCommand({ TableName: tableName, Key: { PK: room, SK: `DEDUP#${hash}` }, ConsistentRead: true }));
          if (prior.Item) return prior.Item.seq;
          await new Promise(resolve => setTimeout(resolve, 10 + Math.random() * 40 * (attempt + 1)));
        }
      }
      throw error(503, 'Collaboration is busy; retry the update');
    },
    async since(room, after, adapter) {
      if (!ddb) return (await localRead(room, adapter)).rows.filter(v => v.seq > after);
      const rows = []; let cursor;
      do {
        const result = await ddb.send(new QueryCommand({ TableName: tableName,
          KeyConditionExpression: 'PK = :pk AND SK BETWEEN :start AND :end',
          ExpressionAttributeValues: { ':pk': room, ':start': logKey(after + 1), ':end': 'UPDATE#9999999999999999' },
          ConsistentRead: true, ExclusiveStartKey: cursor }));
        rows.push(...(result.Items || [])); cursor = result.LastEvaluatedKey;
      } while (cursor);
      return Promise.all(rows.map(async row => {
        if (!row.objectKey) return row;
        const bytes = await adapter.get(row.objectKey);
        if (!bytes) throw error(503, 'A durable update could not be read');
        return { ...row, update: new TextDecoder().decode(bytes) };
      }));
    },
    async prune(room, rows, adapter) {
      // Only delete rows covered by a successfully committed snapshot. Concurrent
      // compactors use the diagram's conditional version, so no newer row is lost.
      if (!ddb) return locked(room, async () => {
        const state = await localRead(room, adapter), covered = new Set(rows.map(row => row.seq));
        await localWrite(room, adapter, { seq: state.seq, rows: state.rows.filter(row => !covered.has(row.seq)) });
      });
      for (let i = 0; i < rows.length; i += 25) {
        await ddb.send(new BatchWriteCommand({ RequestItems: { [tableName]: rows.slice(i, i + 25)
          .map(row => ({ DeleteRequest: { Key: { PK: room, SK: logKey(row.seq) } } })) } }));
        // Unprocessed deletions are harmless retained history, never lost edits.
      }
    }
  };
}

export function createCollaboration({ journal, notify, cache }) {
  const timers = new Map();
  const roomOf = (target, id) => `COLLAB#${target.owner || '_shared'}#${id}`;
  const generationOf = saved => createHash('sha256').update(saved.body.created || 'legacy').digest('hex').slice(0, 24);
  const load = async (target, id) => {
    const cacheKey = roomOf(target, id);
    let cached = target.adapter.getDiagramState ? await cache?.cacheGet?.(cacheKey) : null;
    if (cached) {
      const metadata = await target.adapter.getDiagramState(id);
      if (!metadata || metadata.version !== routes.versionFromIfMatch(cached.saved.headers?.ETag)) cached = null;
    }
    const saved = cached?.saved || await routes.getDiagram(target.adapter, { params: { id } });
    if (saved.body.deletedAt) throw error(410, 'Diagram is in the trash');
    const generation = generationOf(saved);
    const room = `${roomOf(target, id)}#${generation}`;
    const doc = new Y.Doc();
    let seq = cached?.seq ?? saved.body._collab?.seq ?? 0;
    if (cached?.state) Y.applyUpdate(doc, decode(cached.state));
    else if (saved.body._collab?.state) Y.applyUpdate(doc, decode(saved.body._collab.state));
    else {
      const key = `collaboration/${id}/${generation}/seed`;
      let bytes = await target.adapter.get(key);
      if (!bytes) {
        const initial = seedModel(saved.body, new Y.Doc());
        await target.adapter.putIfAbsent(key, Y.encodeStateAsUpdate(initial)); initial.destroy();
        bytes = await target.adapter.get(key);
      }
      Y.applyUpdate(doc, bytes);
    }
    const rows = await journal.since(room, seq, target.adapter);
    const unchanged = target.adapter.getDiagramState
      ? (await target.adapter.getDiagramState(id))?.version === routes.versionFromIfMatch(saved.headers?.ETag)
      : (await routes.getDiagram(target.adapter, { params: { id } })).body.lastModified === saved.body.lastModified;
    if (!unchanged) { doc.destroy(); return load(target, id); }
    for (const row of rows) { Y.applyUpdate(doc, decode(row.update)); seq = Math.max(seq, row.seq); }
    await cache?.cacheSet?.(cacheKey, { saved, seq, state: encode(Y.encodeStateAsUpdate(doc)) });
    return { doc, seq, rows, saved, room, generation };
  };
  const snapshot = async (target, id) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const state = await load(target, id);
      try {
        const model = readModel(state.doc);
        const result = await routes.saveDiagram(target.adapter, { params: { id },
          body: { ...state.saved.body, ...model, _collab: { seq: state.seq, state: encode(Y.encodeStateAsUpdate(state.doc)) } },
          ifMatch: routes.versionFromIfMatch(state.saved.headers?.ETag) });
        const covered = await journal.since(state.room, 0, target.adapter);
        await journal.prune(state.room, covered.filter(row => row.seq <= state.seq), target.adapter);
        return result;
      } catch (err) { if (err.status !== 409 || attempt === 4) throw err; }
      finally { state.doc.destroy(); }
    }
  };
  const schedule = (target, id) => {
    const room = roomOf(target, id);
    const previous = timers.get(room);
    const first = previous?.first || Date.now();
    if (previous) clearTimeout(previous.timer);
    // Idle: 2.5s. Continuous collaboration: a bounded 15s checkpoint window.
    const delay = Math.max(0, Math.min(2500, 15000 - (Date.now() - first)));
    const timer = setTimeout(() => {
      timers.delete(room);
      void (async () => { if (!cache?.claim || await cache.claim(room)) await snapshot(target, id); })().catch(err => console.warn('[collaboration] snapshot deferred', err.name));
    }, delay);
    timer.unref?.(); timers.set(room, { first, timer });
  };
  return {
    roomOf, snapshot,
    async active(target, id) {
      const saved = await routes.getDiagram(target.adapter, { params: { id } });
      return !!(await target.adapter.get(`collaboration/${id}/${generationOf(saved)}/seed`));
    },
    async state(target, id, vector) {
      if (vector && (typeof vector !== 'string' || vector.length > 32000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(vector))) throw error(400, 'Invalid state vector');
      const state = await load(target, id);
      try { return { update: encode(Y.encodeStateAsUpdate(state.doc, vector ? decode(vector) : undefined)), vector: encode(Y.encodeStateVector(state.doc)), seq: state.seq, etag: state.saved.headers?.ETag, lastModified: state.saved.body.lastModified, generation: state.generation, model: readModel(state.doc), writable: target.role !== 'viewer' }; }
      finally { state.doc.destroy(); }
    },
    async update(target, id, update, origin, agent, expectedGeneration) {
      if (typeof update !== 'string' || update.length > MAX_UPDATE_BYTES * 4 / 3 || !/^[A-Za-z0-9+/]*={0,2}$/.test(update)) throw error(413, 'Invalid or oversized update');
      const state = await load(target, id);
      try {
        if (expectedGeneration && state.generation !== expectedGeneration) throw error(409, 'Diagram was replaced');
        Y.applyUpdate(state.doc, decode(update));
        const model = readModel(state.doc);
        if (!Array.isArray(model.items) || !Array.isArray(model.views) || typeof model.title !== 'string') throw error(400, 'Invalid diagram update');
        if (JSON.stringify(model).length > 8 * 1024 * 1024) throw error(413, 'Diagram too large');
      } catch (err) { throw err.status ? err : error(400, 'Invalid Yjs update'); }
      finally { state.doc.destroy(); }
      const seq = await journal.append(state.room, update, target.adapter);
      // Persist first. Pub/Sub is only a latency optimization; replay survives
      // Redis failover, dropped subscriptions and API pod loss.
      await notify(target, { kind: 'collaboration', generation: state.generation, action: 'save', id, origin, ...(agent ? { agent } : {}), ...(update.length < 128 * 1024 ? { update } : {}), documentSeq: seq });
      schedule(target, id);
      return { seq };
    },
    async rename(target, id, title, origin) {
      const state = await load(target, id);
      try {
        const before = readModel(state.doc), vector = Y.encodeStateVector(state.doc);
        patchModel(state.doc, before, { ...before, title });
        return this.update(target, id, encode(Y.encodeStateAsUpdate(state.doc, vector)), origin);
      } finally { state.doc.destroy(); }
    },
    async replace(target, id, body, expectedVersion, origin, agent) {
      const state = await load(target, id);
      try {
        if (routes.versionFromIfMatch(state.saved.headers?.ETag) !== expectedVersion) throw error(409, 'Reload before applying a whole-document change');
        const vector = Y.encodeStateVector(state.doc);
        patchModel(state.doc, state.saved.body, body);
        await this.update(target, id, encode(Y.encodeStateAsUpdate(state.doc, vector)), origin, agent);
      } finally { state.doc.destroy(); }
      return snapshot(target, id);
    }
  };
}
