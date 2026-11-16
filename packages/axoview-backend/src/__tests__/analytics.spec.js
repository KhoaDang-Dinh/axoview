import { gunzipSync } from 'node:zlib';
import { createAnalyticsRouter, archiveAnalyticsBatch, validateAnalyticsBatch } from '../analytics.js';
import express from 'express';
import http from 'node:http';

const sessionId = '120f4a14-4610-4adb-8e3b-0fb2d00c7819';
const eventId = '20c93bfc-8e4a-45b4-af2b-ec34030a8749';
const batch = { sessionId, events: [{ name: 'diagram_opened', eventId }] };

test('accepts only bounded allowlisted events and no private metadata', () => {
  expect(validateAnalyticsBatch(batch)).toEqual(batch);
  for (const invalid of [
    { ...batch, userId: 'secret' },
    { ...batch, events: [{ ...batch.events[0], diagramId: 'private' }] },
    { ...batch, events: [{ ...batch.events[0], name: 'prompt_text' }] },
    { ...batch, events: Array(21).fill(batch.events[0]) },
    { ...batch, events: [batch.events[0], batch.events[0]] },
    { ...batch, sessionId: '../../other-tenant' }
  ]) expect(() => validateAnalyticsBatch(invalid)).toThrow();
});

test('archive is gzip NDJSON with UTC partitions and no account identity', () => {
  const object = archiveAnalyticsBatch(batch, new Date('2026-11-13T06:25:10.000Z'), 'object-1');
  expect(object.Key).toBe('analytics/events/dt=2026-11-13/hour=06/object-1.json.gz');
  const record = JSON.parse(gunzipSync(object.Body).toString().trim());
  expect(record).toEqual({
    schema_version: 1, received_at: '2026-11-13T06:25:10.000Z',
    session_id: sessionId, event_id: eventId, event_name: 'diagram_opened'
  });
  expect(JSON.stringify(record)).not.toContain('userId');
});

async function request(router, { signedIn = true, method = 'POST', body = batch } = {}) {
  const app = express();
  app.use(express.json());
  if (signedIn) app.use((req, _res, next) => { req.user = { sub: 'private-id' }; next(); });
  app.use('/api/analytics', router);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/analytics/' + (method === 'GET' ? 'status' : 'events'), {
      method, ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
    });
    return { status: response.status, json: await response.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('defaults off and rejects anonymous writes', async () => {
  const disabled = createAnalyticsRouter({ enabled: false, bucket: 'test', authMode: 'cognito' });
  expect((await request(disabled)).status).toBe(404);
  expect((await request(disabled, { method: 'GET' })).json.enabled).toBe(false);
  const enabled = createAnalyticsRouter({ enabled: true, bucket: 'test', authMode: 'cognito', putObject: async () => {} });
  expect((await request(enabled, { signedIn: false })).status).toBe(401);
});

test('acknowledges only after S3 accepted the batch; storage errors return 503', async () => {
  const writes = [];
  const good = createAnalyticsRouter({ enabled: true, bucket: 'test', authMode: 'cognito',
    putObject: async (input) => { writes.push(input); } });
  expect((await request(good)).status).toBe(202);
  expect(writes).toHaveLength(1);
  expect(writes[0].Bucket).toBe('test');
  const bad = createAnalyticsRouter({ enabled: true, bucket: 'test', authMode: 'cognito',
    putObject: async () => { throw new Error('bad'); }, log: { error() {} } });
  expect((await request(bad)).status).toBe(503);
});

test('rate-limits excessive authenticated batches before writing more objects', async () => {
  let count = 0;
  const router = createAnalyticsRouter({ enabled: true, bucket: 'test', authMode: 'cognito',
    putObject: async () => { count += 1; } });
  for (let i = 0; i < 12; i++) expect((await request(router)).status).toBe(202);
  expect((await request(router)).status).toBe(429);
  expect(count).toBe(12);
});
