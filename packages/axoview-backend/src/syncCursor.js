/**
 * Per-workspace change cursor for realtime multi-device sync.
 *
 * Every successful write (a diagram saved, renamed, moved or deleted, a folder
 * change, a tree-layout save) bumps the workspace's cursor: a sequence number
 * plus a description of that last change. `GET /api/sync/events` (server.js)
 * watches the cursor and streams each change to the user's other devices as a
 * Server-Sent Event, so a save on one device shows on the others within about a
 * second.
 *
 * Each change is also kept in a short per-workspace log (the queue), so a
 * stream that is several changes behind (two saves inside one poll, a tab
 * reconnecting after a few seconds) replays every one of them in order
 * instead of being told to `resync`. A delete in a burst therefore still
 * arrives as a delete.
 *
 * Two stores, one interface:
 *  - DynamoDB (STORAGE_ADAPTER=aws): the cursor is one item per workspace,
 *    PK `WORKSPACE#<id>`, SK `SYNC`, shared by every API pod; streams poll it.
 *    The log is one item per change, SK `SYNC#<seq, 15 digits>`, expiring
 *    after an hour (the table's `expiresAt` TTL). Only a stream that is more
 *    than one change behind queries it.
 *  - Memory (fs adapter, self-host): one process, so an in-process counter,
 *    the last LOG_LIMIT changes, and an event emitter that wakes waiting
 *    streams at once.
 *
 * Still `resync`: more than MAX_REPLAY changes missed, a log entry that never
 * appears (older than the log, or its write failed), or a sequence that went
 * backwards (a rebuilt table, a restarted self-host server).
 */
import { EventEmitter } from 'events';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

/** Workspace for deployments without per-user identity (AUTH_MODE none / shared-token). */
export const SHARED_WORKSPACE = '_shared';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Changes the memory store keeps per workspace. */
export const LOG_LIMIT = 200;
/** A stream further behind than this re-reads everything instead (`resync`). */
export const MAX_REPLAY = 100;
/** How long the DynamoDB log keeps a change. */
const LOG_TTL_SECONDS = 3600;
const logKey = (seq) => `SYNC#${String(seq).padStart(15, '0')}`;

export function createMemorySyncCursor() {
  const state = new Map();
  const logs = new Map();
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);

  return {
    async bump(workspaceId, change) {
      const seq = (state.get(workspaceId)?.seq || 0) + 1;
      state.set(workspaceId, { seq, change });
      const log = logs.get(workspaceId) || [];
      log.push({ seq, change });
      if (log.length > LOG_LIMIT) log.splice(0, log.length - LOG_LIMIT);
      logs.set(workspaceId, log);
      emitter.emit(workspaceId);
      return seq;
    },
    async read(workspaceId) {
      return state.get(workspaceId) || { seq: 0, change: null };
    },
    /** The logged changes with afterSeq < seq <= uptoSeq, oldest first. */
    async since(workspaceId, afterSeq, uptoSeq) {
      return (logs.get(workspaceId) || [])
        .filter((entry) => entry.seq > afterSeq && entry.seq <= uptoSeq)
        .map((entry) => ({ ...entry }));
    },
    /** Resolves after `ms`, or as soon as the workspace changes. */
    wait(workspaceId, ms) {
      return new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          emitter.off(workspaceId, done);
          resolve();
        };
        const timer = setTimeout(done, ms);
        emitter.on(workspaceId, done);
      });
    }
  };
}

export function createDynamoSyncCursor({ tableName, region, ddbClient }) {
  if (!tableName) throw new Error('A DynamoDB table is required for the sync cursor');
  const ddb = ddbClient || DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
    marshallOptions: { removeUndefinedValues: true }
  });
  const key = (workspaceId) => ({ PK: `WORKSPACE#${workspaceId}`, SK: 'SYNC' });

  return {
    async bump(workspaceId, change) {
      const result = await ddb.send(new UpdateCommand({
        TableName: tableName,
        Key: key(workspaceId),
        UpdateExpression: 'SET #change = :change ADD #seq :one',
        ExpressionAttributeNames: { '#change': 'change', '#seq': 'seq' },
        ExpressionAttributeValues: { ':change': change, ':one': 1 },
        ReturnValues: 'UPDATED_NEW'
      }));
      const seq = Number(result.Attributes?.seq || 0);
      // The queue entry. Written after the bump, so a stream can see the new
      // sequence a moment before its entry: it waits for it (collectSyncEvents
      // callers), and only falls back to resync if it never appears.
      await ddb.send(new PutCommand({
        TableName: tableName,
        Item: {
          PK: `WORKSPACE#${workspaceId}`,
          SK: logKey(seq),
          seq,
          change,
          expiresAt: Math.floor(Date.now() / 1000) + LOG_TTL_SECONDS
        }
      }));
      return seq;
    },
    async read(workspaceId) {
      const result = await ddb.send(new GetCommand({
        TableName: tableName,
        Key: key(workspaceId),
        ConsistentRead: true,
        ProjectionExpression: '#seq, #change',
        ExpressionAttributeNames: { '#seq': 'seq', '#change': 'change' }
      }));
      return { seq: Number(result.Item?.seq || 0), change: result.Item?.change || null };
    },
    async since(workspaceId, afterSeq, uptoSeq) {
      if (uptoSeq <= afterSeq) return [];
      const result = await ddb.send(new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'PK = :pk AND SK BETWEEN :from AND :to',
        ExpressionAttributeValues: {
          ':pk': `WORKSPACE#${workspaceId}`,
          ':from': logKey(afterSeq + 1),
          ':to': logKey(uptoSeq)
        },
        ConsistentRead: true,
        Limit: Math.min(uptoSeq - afterSeq, MAX_REPLAY)
      }));
      return (result.Items || []).map((item) => ({ seq: Number(item.seq), change: item.change }));
    },
    wait(_workspaceId, ms) {
      return sleep(ms);
    }
  };
}

/**
 * What one write changed, as sent to the other devices. Returns null for a
 * request that changes nothing another device shows.
 *
 *   kind     diagram | folder | tree
 *   action   create | save | update | move | delete
 *   id       the diagram or folder id (absent for the tree layout)
 *   version  the diagram's new version, when the write returned one (ETag)
 *   name     a diagram's new name, on a rename
 *   deleted  true when a diagram moved to (or out of: false) the trash
 */
export function describeChange({ method, route, params = {}, body = {}, result = {} }) {
  const etag = result.headers?.ETag;
  const version = typeof etag === 'string' && /^"[1-9][0-9]*"$/.test(etag)
    ? Number(etag.slice(1, -1))
    : undefined;
  const id = params.id || (typeof result.body?.id === 'string' ? result.body.id : undefined);

  switch (`${method} ${route}`) {
    case 'POST /api/diagrams':
      return { kind: 'diagram', action: 'create', id, version };
    case 'PUT /api/diagrams/:id':
      return { kind: 'diagram', action: 'save', id, version };
    case 'PATCH /api/diagrams/:id': {
      const change = { kind: 'diagram', action: 'update', id, version };
      if (typeof body?.name === 'string') change.name = body.name;
      if (body && 'deletedAt' in body) change.deleted = body.deletedAt != null;
      return change;
    }
    case 'PATCH /api/diagrams/:id/move':
      return { kind: 'diagram', action: 'move', id };
    case 'DELETE /api/diagrams/:id':
      return { kind: 'diagram', action: 'delete', id };
    case 'POST /api/folders':
      return { kind: 'folder', action: 'create', id };
    case 'PUT /api/folders/:id':
      return { kind: 'folder', action: 'update', id };
    case 'PATCH /api/folders/:id/move':
      return { kind: 'folder', action: 'move', id };
    case 'DELETE /api/folders/:id':
      return { kind: 'folder', action: 'delete', id };
    case 'PUT /api/tree-manifest':
      return { kind: 'tree', action: 'save' };
    default:
      return null;
  }
}

/** One Server-Sent Event frame. */
export function sseFrame(event, seq, data) {
  return `id: ${seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * The event a stream at `lastSeq` sends for `current`, or null for no change.
 * Exactly one change since the last event: that change. More than one (missed
 * between polls), or a sequence that went backwards: `resync`, so the device
 * re-reads what it shows.
 */
export function nextSyncEvent(lastSeq, current) {
  if (lastSeq == null || current.seq === lastSeq) return null;
  if (current.seq === lastSeq + 1 && current.change) {
    return { event: 'change', seq: current.seq, data: { seq: current.seq, ...current.change } };
  }
  return { event: 'change', seq: current.seq, data: { seq: current.seq, kind: 'resync' } };
}

/**
 * Everything a stream at `lastSeq` should send now that the cursor is at
 * `current`, replaying the queue when it is more than one change behind.
 * Returns the events, the sequence the stream has reached, and whether that
 * is `current.seq` (complete). Incomplete: a log entry is not readable yet;
 * the caller retries on its next poll and falls back to `resync` if the gap
 * outlives a few polls (see server.js).
 */
export async function collectSyncEvents(cursor, workspaceId, lastSeq, current, maxReplay = MAX_REPLAY) {
  const change = (seq, data) => ({ event: 'change', seq, data: { seq, ...data } });
  const resync = () => ({ events: [change(current.seq, { kind: 'resync' })], lastSeq: current.seq, complete: true });
  if (lastSeq == null || current.seq === lastSeq) {
    return { events: [], lastSeq: lastSeq ?? current.seq, complete: true };
  }
  if (current.seq < lastSeq || current.seq - lastSeq > maxReplay) return resync();
  if (current.seq === lastSeq + 1 && current.change) {
    return { events: [change(current.seq, current.change)], lastSeq: current.seq, complete: true };
  }
  const log = cursor.since ? await cursor.since(workspaceId, lastSeq, current.seq) : [];
  const events = [];
  let reached = lastSeq;
  for (const entry of [...log].sort((a, b) => a.seq - b.seq)) {
    if (entry.seq !== reached + 1 || !entry.change) break;
    events.push(change(entry.seq, entry.change));
    reached = entry.seq;
  }
  return { events, lastSeq: reached, complete: reached === current.seq };
}

/** The resync event for a stream that cannot replay what it missed. */
export function resyncEvent(seq) {
  return { event: 'change', seq, data: { seq, kind: 'resync' } };
}
