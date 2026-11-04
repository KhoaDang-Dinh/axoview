/**
 * Route-level tests for the Phase 2 chat router: the order of paid calls,
 * quota accounting, the conversation list and fail-closed configuration.
 * DynamoDB, Bedrock and the guardrail are in-memory fakes; requests go through
 * a real Express app on an ephemeral port.
 */
import { afterEach, expect, jest, test } from '@jest/globals';
import http from 'node:http';
import express from 'express';
import { createAiChatRouter } from '../chat.js';
import { defaultModelFor, validateBedrockConfig } from '../bedrock.js';

/** A DynamoDB stand-in: conditional quota updates, Get/Put, and a Query that
 *  pages in key (SK) order like the real service. */
function fakeDynamo({ pageSize = 25 } = {}) {
  const items = new Map();
  const id = (key) => `${key.PK}|${key.SK}`;
  const send = jest.fn(async (command) => {
    const kind = command.constructor.name;
    const input = command.input;
    if (kind === 'GetCommand') return { Item: items.get(id(input.Key)) };
    if (kind === 'PutCommand') {
      const current = items.get(id(input.Item));
      const expected = input.ExpressionAttributeValues?.[':old'];
      if ((expected !== undefined && current?.version !== expected) ||
          (input.ConditionExpression === 'attribute_not_exists(PK)' && current)) {
        throw Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException' });
      }
      items.set(id(input.Item), input.Item);
      return {};
    }
    if (kind === 'UpdateCommand') {
      const item = items.get(id(input.Key)) || { ...input.Key };
      const values = input.ExpressionAttributeValues || {};
      if (input.ConditionExpression && (item.requests || 0) >= values[':limit']) {
        throw Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException' });
      }
      if (':one' in values) item.requests = (item.requests || 0) + 1;
      if (':minusOne' in values) item.requests = (item.requests || 0) - 1;
      items.set(id(input.Key), item);
      return { Attributes: item };
    }
    if (kind === 'QueryCommand') {
      const pk = input.ExpressionAttributeValues[':pk'];
      const rows = [...items.values()]
        .filter((item) => item.PK === pk && item.SK.startsWith('CHAT#'))
        .sort((a, b) => a.SK.localeCompare(b.SK));
      const start = input.ExclusiveStartKey
        ? rows.findIndex((row) => row.SK === input.ExclusiveStartKey.SK) + 1 : 0;
      const page = rows.slice(start, start + pageSize);
      const more = start + pageSize < rows.length;
      return { Items: page, ...(more ? { LastEvaluatedKey: { PK: pk, SK: page[page.length - 1].SK } } : {}) };
    }
    throw new Error(`unexpected command ${kind}`);
  });
  return { items, send };
}

const servers = [];
afterEach(() => { while (servers.length) servers.pop().close(); });

async function serve(router, sub = 'user-1') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { sub }; next(); });
  app.use('/api/ai', router);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}/api/ai`;
  return {
    post: (body) => fetch(`${base}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    }),
    get: (path) => fetch(`${base}${path}`)
  };
}

function chatRouter(overrides = {}) {
  const calls = { guardrail: 0, model: 0 };
  const ddb = overrides.ddb || fakeDynamo();
  const router = createAiChatRouter({
    enabled: true,
    authMode: 'cognito',
    tableName: 'app',
    region: 'ap-southeast-1',
    ddb,
    invokeNova: async () => { calls.model++; return { text: 'Hello', usage: { inputTokens: 3, outputTokens: 1 } }; },
    inspectGuardrail: async () => { calls.guardrail++; return true; },
    telemetry: () => {},
    log: { warn: () => {}, error: () => {} },
    ...overrides
  });
  return { router, calls, ddb };
}

test('over the daily quota, no Bedrock call is made (guardrail or model)', async () => {
  const { router, calls } = chatRouter({ userDailyLimit: 2 });
  const api = await serve(router);
  const statuses = [];
  for (let i = 0; i < 6; i++) statuses.push((await api.post({ message: 'hello there' })).status);
  expect(statuses).toEqual([200, 200, 429, 429, 429, 429]);
  expect(calls.model).toBe(2);
  // One input and one output check per answered message; none for refused ones.
  expect(calls.guardrail).toBe(4);
});

test('a refused global cap gives the user their reservation back', async () => {
  const { router, ddb, calls } = chatRouter({ userDailyLimit: 5, globalDailyLimit: 1 });
  const api = await serve(router, 'user-1');
  expect((await api.post({ message: 'first' })).status).toBe(200);
  expect((await api.post({ message: 'second' })).status).toBe(429);
  const day = new Date().toISOString().slice(0, 10);
  expect(ddb.items.get(`AI#QUOTA#user-1|DAY#${day}`).requests).toBe(1);
  expect(calls.model).toBe(1);
});

test('an unknown conversation is a 404 before any quota or Bedrock use', async () => {
  const { router, ddb, calls } = chatRouter();
  const api = await serve(router);
  const response = await api.post({ message: 'hi', conversationId: '6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f' });
  expect(response.status).toBe(404);
  expect(calls).toEqual({ guardrail: 0, model: 0 });
  expect([...ddb.items.keys()].some((key) => key.startsWith('AI#QUOTA#'))).toBe(false);
});

test('the conversation list is the newest 30, across pages, in recency order', async () => {
  const ddb = fakeDynamo({ pageSize: 7 });
  for (let i = 0; i < 40; i++) {
    // Random-looking ids: key order differs from recency order.
    const conversationId = `${(i * 2654435761 % 4294967296).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
    ddb.items.set(`AI#USER#user-1|CHAT#${conversationId}`, {
      PK: 'AI#USER#user-1', SK: `CHAT#${conversationId}`, conversationId,
      updatedAt: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
      messages: [{ role: 'user', text: `question ${i}` }]
    });
  }
  const { router } = chatRouter({ ddb });
  const api = await serve(router);
  const { conversations } = await (await api.get('/conversations')).json();
  expect(conversations).toHaveLength(30);
  expect(conversations[0].preview).toBe('question 39');
  expect(conversations[29].preview).toBe('question 10');
});

test('one user cannot read or continue another user\'s conversation', async () => {
  const { router, ddb } = chatRouter();
  const alice = await serve(router, 'alice');
  const { conversationId } = await (await alice.post({ message: 'private question' })).json();
  expect(ddb.items.has(`AI#USER#alice|CHAT#${conversationId}`)).toBe(true);
  const bob = await serve(router, 'bob');
  expect((await bob.get(`/conversations/${conversationId}`)).status).toBe(404);
  expect((await bob.post({ message: 'hi', conversationId })).status).toBe(404);
});

test('an invalid AI setting disables /api/ai instead of throwing', async () => {
  const errors = [];
  let router;
  expect(() => {
    router = createAiChatRouter({
      enabled: true, authMode: 'cognito', tableName: 'app', region: 'ap-southeast-1',
      modelId: 'anthropic.some-model', guardrailId: 'abc123', guardrailVersion: '1',
      log: { warn: () => {}, error: (...args) => errors.push(args.join(' ')) }
    });
  }).not.toThrow();
  expect(router.ready).toBe(false);
  expect(errors.join('')).toMatch(/approved Amazon Nova/);
  const api = await serve(router);
  expect((await api.post({ message: 'hello' })).status).toBe(503);
});

test('a malformed guardrail ID also only disables /api/ai', () => {
  const router = createAiChatRouter({
    enabled: true, authMode: 'cognito', tableName: 'app', region: 'ap-southeast-1',
    guardrailId: 'Not A Guardrail', guardrailVersion: '1', log: { warn: () => {}, error: () => {} }
  });
  expect(router.ready).toBe(false);
});

test('readiness needs chat, Cognito, a table, a model and a guardrail', () => {
  const base = { enabled: true, authMode: 'cognito', tableName: 'app', region: 'ap-southeast-1',
    ddb: fakeDynamo(), log: { warn: () => {}, error: () => {} } };
  const fakes = { invokeNova: async () => ({}), inspectGuardrail: async () => true };
  expect(createAiChatRouter({ ...base, ...fakes }).ready).toBe(true);
  expect(createAiChatRouter({ ...base, ...fakes, enabled: false }).ready).toBe(false);
  expect(createAiChatRouter({ ...base, ...fakes, authMode: 'none' }).ready).toBe(false);
  expect(createAiChatRouter({ ...base, ...fakes, tableName: '' }).ready).toBe(false);
  // No guardrail configured: never ready, so no unguarded model call.
  expect(createAiChatRouter({ ...base, invokeNova: fakes.invokeNova }).ready).toBe(false);
});

test('Nova inference profiles are accepted, and each region defaults to its profile', () => {
  expect(() => validateBedrockConfig({ region: 'ap-southeast-1', modelId: 'apac.amazon.nova-lite-v1:0' })).not.toThrow();
  expect(() => validateBedrockConfig({ region: 'us-east-1', modelId: 'us.amazon.nova-pro-v1:0' })).not.toThrow();
  expect(() => validateBedrockConfig({ region: 'ap-southeast-1', modelId: 'apac.anthropic.claude-v2' })).toThrow();
  expect(() => validateBedrockConfig({ region: 'ap-southeast-1', modelId: 'global.amazon.nova-lite-v1:0' })).toThrow();
  expect(defaultModelFor('ap-southeast-1')).toBe('apac.amazon.nova-lite-v1:0');
  expect(defaultModelFor('eu-west-1')).toBe('eu.amazon.nova-lite-v1:0');
  expect(defaultModelFor('us-gov-west-1')).toBe('amazon.nova-lite-v1:0');
});
