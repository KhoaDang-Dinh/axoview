/**
 * Phase 2: authenticated, synchronous AI chat.
 * Cognito verification MUST run in server.js before this router is mounted.
 * No guest/model usage, diagram context, MCP, RAG or tool execution in this phase.
 */
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand
} from '@aws-sdk/lib-dynamodb';
import { createNovaClient, DEFAULT_AI_MODEL_ID } from './bedrock.js';

const CONVERSATION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LIMIT_HISTORY_MESSAGES = 12;
const PROMPT_LENGTH = 2000;
const TTL_SECONDS = 30 * 86400;
const MAX_CONVERSATIONS = 30;

const responseError = (status, message) => Object.assign(new Error(message), { status });

export function validateChatInput(body) {
  if (!body || typeof body.message !== 'string') throw responseError(400, 'Message must be text');
  const message = body.message.trim();
  if (!message || message.length > PROMPT_LENGTH) {
    throw responseError(400, 'Message must contain 1–2000 characters');
  }
  const conversationId = body.conversationId;
  if (conversationId !== undefined && (!CONVERSATION_RE.test(conversationId))) {
    throw responseError(400, 'Invalid conversation ID');
  }
  // Do not accept context selectors or user/workspace identifiers in Phase 2.
  return { message, conversationId: conversationId || null };
}

function settingsInt(value, fallback, min, max) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}

export function createAiChatRouter({
  enabled = process.env.AI_CHAT_ENABLED === 'true',
  authMode = process.env.AUTH_MODE,
  tableName = process.env.DYNAMODB_TABLE || process.env.AXOVIEW_DYNAMODB_TABLE,
  region = process.env.AI_BEDROCK_REGION || process.env.AWS_REGION,
  modelId = process.env.AI_BEDROCK_MODEL_ID || DEFAULT_AI_MODEL_ID,
  userDailyLimit = settingsInt(process.env.AI_USER_DAILY_LIMIT, 20, 1, 100),
  globalDailyLimit = settingsInt(process.env.AI_GLOBAL_DAILY_LIMIT, 250, 1, 10000),
  ddb,
  invokeNova,
  now = () => new Date()
} = {}) {
  const router = Router();
  const client = ddb || (tableName && region
    ? DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
      marshallOptions: { removeUndefinedValues: true }
    }) : null);
  // Avoid evaluating Bedrock config or requesting credentials while disabled.
  const invoke = invokeNova || (enabled && region ? createNovaClient({ region, modelId }) : null);
  router.use((req, res, next) => {
    if (!enabled) return res.status(404).json({ error: 'AI chat is disabled' });
    if (authMode !== 'cognito' || !req.user?.sub) {
      return res.status(401).json({ error: 'Sign in to use Axoview AI' });
    }
    if (!tableName || !client || !invoke) {
      return res.status(503).json({ error: 'AI chat service is not configured' });
    }
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  const pk = (actor) => `AI#USER#${actor}`;
  const key = (actor, id) => ({ PK: pk(actor), SK: `CHAT#${id}` });
  const getChat = async (actor, id) => {
    const { Item } = await client.send(new GetCommand({
      TableName: tableName, Key: key(actor, id), ConsistentRead: true
    }));
    return Item || null;
  };
  const wrap = (handler) => async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (error?.name === 'ConditionalCheckFailedException') {
        return res.status(409).json({ error: 'Conversation changed; reload and retry' });
      }
      if (typeof error?.status === 'number' && error.status >= 400 && error.status < 500) {
        return res.status(error.status).json({ error: error.message });
      }
      console.warn('[ai] request failed: %s', error?.name || 'unknown');
      return res.status(503).json({ error: 'AI service temporarily unavailable' });
    }
  };
  const reserveRequest = async (quotaPk, limit, date, expiration) => {
    try {
      const response = await client.send(new UpdateCommand({
        TableName: tableName,
        Key: { PK: quotaPk, SK: `DAY#${date}` },
        UpdateExpression: 'SET #expires = :expires ADD #requests :one',
        ConditionExpression: 'attribute_not_exists(#requests) OR #requests < :limit',
        ExpressionAttributeNames: { '#expires': 'expiresAt', '#requests': 'requests' },
        ExpressionAttributeValues: {
          ':expires': expiration, ':one': 1, ':limit': limit
        },
        ReturnValues: 'ALL_NEW'
      }));
      return response.Attributes?.requests || 1;
    } catch (error) {
      if (error?.name === 'ConditionalCheckFailedException') {
        throw responseError(429, 'Daily AI request quota reached');
      }
      throw error;
    }
  };
  const addUsage = async (quotaPk, date, usage) => {
    try {
      await client.send(new UpdateCommand({
        TableName: tableName,
        Key: { PK: quotaPk, SK: `DAY#${date}` },
        UpdateExpression: 'ADD inputTokens :input, outputTokens :output',
        ExpressionAttributeValues: {
          ':input': usage.inputTokens,
          ':output': usage.outputTokens
        }
      }));
    } catch (error) {
      console.warn('[ai] could not record token usage: %s', error?.name || 'unknown');
    }
  };

  router.get('/conversations', wrap(async (req, res) => {
    const actor = req.user.sub;
    const { Items = [] } = await client.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': pk(actor), ':prefix': 'CHAT#' },
      Limit: MAX_CONVERSATIONS
    }));
    return res.json({
      conversations: Items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map(({ conversationId, updatedAt, messages }) => ({
          conversationId, updatedAt, preview: messages?.[0]?.text?.slice(0, 100) || ''
        }))
    });
  }));

  router.get('/conversations/:id', wrap(async (req, res) => {
    if (!CONVERSATION_RE.test(req.params.id)) throw responseError(400, 'Invalid conversation ID');
    const chat = await getChat(req.user.sub, req.params.id);
    if (!chat) throw responseError(404, 'Conversation not found');
    res.json({
      conversationId: chat.conversationId, updatedAt: chat.updatedAt, messages: chat.messages || []
    });
  }));

  router.post('/messages', wrap(async (req, res) => {
    const { message, conversationId: existingId } = validateChatInput(req.body);
    const actor = req.user.sub;
    const id = existingId || randomUUID();
    const prior = existingId ? await getChat(actor, existingId) : null;
    if (existingId && !prior) throw responseError(404, 'Conversation not found');

    const date = now();
    const day = date.toISOString().slice(0, 10);
    const expires = Math.floor(date.getTime() / 1000) + TTL_SECONDS;
    // Distributed, atomic per-user and global ceilings BEFORE model invocation.
    // A failure may consume one quota reservation, but cannot spend model tokens.
    const used = await reserveRequest(`AI#QUOTA#${actor}`, userDailyLimit, day, expires);
    await reserveRequest('AI#QUOTA#GLOBAL', globalDailyLimit, day, expires);

    const history = (prior?.messages || []).slice(-LIMIT_HISTORY_MESSAGES).map(({ role, text }) => ({ role, text }));
    const output = await invoke([...history, { role: 'user', text: message }]);
    const reply = output.text.slice(0, 6000);
    const usage = {
      inputTokens: Math.max(0, Number(output.usage?.inputTokens) || 0),
      outputTokens: Math.max(0, Number(output.usage?.outputTokens) || 0)
    };
    const messages = [...history,
      { role: 'user', text: message }, { role: 'assistant', text: reply }].slice(-LIMIT_HISTORY_MESSAGES);
    const version = (prior?.version || 0) + 1;
    await client.send(new PutCommand({
      TableName: tableName,
      Item: {
        ...key(actor, id), conversationId: id, version, messages,
        updatedAt: date.toISOString(), expiresAt: expires
      },
      ...(prior ? {
        ConditionExpression: '#v = :old',
        ExpressionAttributeNames: { '#v': 'version' },
        ExpressionAttributeValues: { ':old': prior.version }
      } : { ConditionExpression: 'attribute_not_exists(PK)' })
    }));
    await Promise.all([
      addUsage(`AI#QUOTA#${actor}`, day, usage),
      addUsage('AI#QUOTA#GLOBAL', day, usage)
    ]);
    return res.status(200).json({
      conversationId: id, reply, usage, requestsRemainingToday: Math.max(0, userDailyLimit - used)
    });
  }));
  return router;
}
