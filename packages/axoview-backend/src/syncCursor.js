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
 * Two stores, one interface:
 *  - DynamoDB (STORAGE_ADAPTER=aws): one item per workspace,
 *    PK `WORKSPACE#<id>`, SK `SYNC`, shared by every API pod. Streams poll it
 *    (eventually consistent reads; a missed intermediate change shows as a gap
 *    in the sequence and is sent as `resync`).
 *  - Memory (fs adapter, self-host): one process, so an in-process counter and
 *    an event emitter that wakes waiting streams at once.
 *
 * A sequence that goes backwards (a rebuilt table, a restarted self-host
 * server) is reported as `resync` by the stream, never as "no change".
 */
import { EventEmitter } from 'events';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

/** Workspace for deployments without per-user identity (AUTH_MODE none / shared-token). */
export const SHARED_WORKSPACE = '_shared';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createMemorySyncCursor() {
  const state = new Map();
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);

  return {
    async bump(workspaceId, change) {
      const seq = (state.get(workspaceId)?.seq || 0) + 1;
      state.set(workspaceId, { seq, change });
      emitter.emit(workspaceId);
      return seq;
    },
    async read(workspaceId) {
      return state.get(workspaceId) || { seq: 0, change: null };
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
      return Number(result.Attributes?.seq || 0);
    },
    async read(workspaceId) {
      const result = await ddb.send(new GetCommand({
        TableName: tableName,
        Key: key(workspaceId),
        ProjectionExpression: '#seq, #change',
        ExpressionAttributeNames: { '#seq': 'seq', '#change': 'change' }
      }));
      return { seq: Number(result.Item?.seq || 0), change: result.Item?.change || null };
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
