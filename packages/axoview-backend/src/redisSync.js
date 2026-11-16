import { createClient } from 'redis';
import { EventEmitter } from 'node:events';

/** Redis caches cursor reads and wakes SSE streams across pods. DynamoDB remains
 * the replay authority. Disconnected Redis never blocks durable writes. */
export function withRedisSync(cursor, url) {
  if (!url) return cursor;
  const events = new EventEmitter(); events.setMaxListeners(0);
  const client = createClient({ url, disableOfflineQueue: true, socket: { connectTimeout: 1500 } });
  const subscriber = client.duplicate();
  client.on('error', () => {}); subscriber.on('error', () => {});
  const recent = new Map();
  const remember = (workspace, value) => {
    if ((recent.get(workspace)?.value.seq ?? -1) <= value.seq) {
      recent.set(workspace, { value, until: Date.now() + 1000 });
      if (recent.size > 256) recent.delete(recent.keys().next().value);
    }
    events.emit(workspace);
  };
  const receive = message => {
    try { const { workspace, value } = JSON.parse(message); remember(workspace, value); } catch { /* malformed notification */ }
  };
  subscriber.on('ready', () => { void subscriber.subscribe('axoview:sync', receive).catch(() => {}); });
  void client.connect().catch(() => {});
  void subscriber.connect().catch(() => {});
  return {
    ...cursor,
    async cacheGet(key) {
      if (!client.isReady) return null;
      try {
        const value = await client.withCommandOptions({ timeout: 100 }).get(`axoview:doc:${key}`);
        return value ? JSON.parse(value) : null;
      } catch { return null; }
    },
    async cacheSet(key, value) {
      if (!client.isReady) return;
      const text = JSON.stringify(value);
      if (text.length > 8 * 1024 * 1024) return;
      try { await client.withCommandOptions({ timeout: 100 }).set(`axoview:doc:${key}`, text, { PX: 30000 }); } catch { /* disposable */ }
    },
    async claim(key) {
      if (!client.isReady) return true;
      try { return !!(await client.withCommandOptions({ timeout: 100 }).set(`axoview:compact:${key}`, '1', { NX: true, PX: 2000 })); }
      catch { return true; }
    },
    async bump(workspace, change) {
      const seq = await cursor.bump(workspace, change);
      const value = { seq, change };
      remember(workspace, value);
      if (client.isReady) void client.withCommandOptions({ timeout: 200 }).set(`axoview:cursor:${workspace}`, JSON.stringify(value), { PX: 1000 }).catch(() => {});
      if (client.isReady) void client.publish('axoview:sync', JSON.stringify({ workspace, value })).catch(() => {});
      return seq;
    },
    async read(workspace) {
      const cached = recent.get(workspace);
      if (cached && cached.until > Date.now()) return cached.value;
      if (client.isReady) {
        try {
          const text = await client.withCommandOptions({ timeout: 100 }).get(`axoview:cursor:${workspace}`);
          if (text) { const value = JSON.parse(text); if (value.seq >= (cached?.value.seq ?? 0)) { remember(workspace, value); return value; } }
        } catch { /* use durable replay store during cache failure */ }
      }
      const value = await cursor.read(workspace); remember(workspace, value); return value;
    },
    wait(workspace, ms) {
      return new Promise(resolve => {
        const done = () => { clearTimeout(timer); events.off(workspace, done); resolve(); };
        const timer = setTimeout(done, ms); events.once(workspace, done);
      });
    }
  };
}
