/**
 * Privacy-preserving product-event collector.
 * No account IDs, IPs, diagram IDs, diagram content, prompts or free-form metadata
 * are written to S3. The caller's Cognito identity is verified by server.js,
 * solely to prevent an unauthenticated, public event ingestion endpoint.
 *
 * Small gzip-compressed NDJSON batches are intentionally best-effort. The
 * next scale step is Firehose/SQS compaction, not per-event DynamoDB writes.
 */
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Router } from 'express';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

export const ANALYTICS_EVENTS = Object.freeze([
  'editor_session_started',
  'diagram_opened',
  'ai_message_sent',
  'agent_proposal_approved'
]);
const VALID_EVENT = new Set(ANALYTICS_EVENTS);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BATCH = 20;

export function validateAnalyticsBatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid batch');
  if (Object.keys(body).some((key) => !['sessionId', 'events'].includes(key))) throw new Error('Unexpected field');
  if (!UUID.test(body.sessionId || '') || !Array.isArray(body.events) ||
      body.events.length === 0 || body.events.length > MAX_BATCH) throw new Error('Invalid batch');
  const events = body.events.map((event) => {
    if (!event || typeof event !== 'object' || Array.isArray(event) ||
        Object.keys(event).some((key) => !['name', 'eventId'].includes(key)) ||
        !VALID_EVENT.has(event.name) || !UUID.test(event.eventId || '')) throw new Error('Invalid event');
    return { name: event.name, eventId: event.eventId };
  });
  if (new Set(events.map((event) => event.eventId)).size !== events.length) throw new Error('Duplicate event');
  return { sessionId: body.sessionId, events };
}

export function archiveAnalyticsBatch(batch, now = new Date(), keyId = randomUUID()) {
  const day = now.toISOString().slice(0, 10);
  const hour = now.toISOString().slice(11, 13);
  const records = batch.events.map((event) => ({
    schema_version: 1,
    received_at: now.toISOString(),
    session_id: batch.sessionId,
    event_id: event.eventId,
    event_name: event.name
  }));
  return {
    Key: 'analytics/events/dt=' + day + '/hour=' + hour + '/' + keyId + '.json.gz',
    Body: gzipSync(records.map((event) => JSON.stringify(event)).join('\n') + '\n'),
    ContentType: 'application/x-ndjson',
    ContentEncoding: 'gzip',
    ServerSideEncryption: 'AES256'
  };
}

export function createAnalyticsRouter({
  enabled = process.env.PRODUCT_ANALYTICS_ENABLED === 'true',
  authMode = process.env.AUTH_MODE,
  bucket = process.env.DATA_BUCKET || process.env.AXOVIEW_DATA_BUCKET,
  region = process.env.AWS_REGION,
  putObject,
  log = console
} = {}) {
  const router = Router();
  let client;
  const usable = enabled && authMode === 'cognito' && !!bucket;
  router.get('/status', (_req, res) => res.json({ enabled: !!usable }));
  router.post('/events', async (req, res) => {
    if (!usable) return res.status(404).json({ error: 'Analytics disabled' });
    if (!req.user?.sub) return res.status(401).json({ error: 'Sign in required' });
    let batch;
    try {
      batch = validateAnalyticsBatch(req.body);
    } catch {
      return res.status(400).json({ error: 'Invalid analytics event batch' });
    }
    try {
      const object = archiveAnalyticsBatch(batch);
      if (putObject) await putObject({ Bucket: bucket, ...object });
      else {
        client ||= new S3Client({ region });
        await client.send(new PutObjectCommand({ Bucket: bucket, ...object }));
      }
      return res.status(202).json({ accepted: batch.events.length });
    } catch (error) {
      // Never log request body, user ID, or event/session identifiers.
      log.error?.('[analytics] batch storage failed: %s', error?.name || 'unknown');
      return res.status(503).json({ error: 'Analytics temporarily unavailable' });
    }
  });
  return router;
}
