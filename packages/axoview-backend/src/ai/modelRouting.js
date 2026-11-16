/**
 * Which model answers a chat message (ADR 0061): the
 * deployment's configured Nova model (fast, cheap) for plain questions, or a
 * stronger one for the work a small model does worst. Off unless
 * AI_MODEL_ROUTING_ENABLED.
 *
 * The choice uses only what the chat endpoint already knows before it calls a
 * model, so routing costs no extra model call, works in any language and in
 * any region (Bedrock's Intelligent Prompt Routing is English-only and is not
 * offered in ap-southeast-1). Rules, first match wins:
 *
 *   page    the person shared the open page: suggestions are expected
 *   tools   the agent loop offers workspace tools: tool use needs the stronger model
 *   long    a long question, or a conversation well under way
 *   plain   everything else: the fast model
 *
 * Nothing else depends on the choice: the guardrail, the quota, the history
 * and the reply's shape are the same on either model.
 */
import { validateBedrockConfig } from './bedrock.js';

export const LONG_QUESTION_CHARS = 600;
export const LONG_HISTORY_MESSAGES = 8;

/**
 * @param {object} o
 * @param {boolean} o.sharedPage      the message came with the open page
 * @param {boolean} o.workspaceTools  the agent loop is on and can read the person's diagrams
 * @param {number} o.questionChars    length of the question
 * @param {number} o.historyMessages  earlier messages sent with it
 * @returns {{ tier: 'fast'|'strong', reason: 'page'|'tools'|'long'|'plain' }}
 */
export function chooseModel({ sharedPage = false, workspaceTools = false, questionChars = 0, historyMessages = 0 } = {}) {
  if (sharedPage) return { tier: 'strong', reason: 'page' };
  if (workspaceTools) return { tier: 'strong', reason: 'tools' };
  if (questionChars > LONG_QUESTION_CHARS || historyMessages >= LONG_HISTORY_MESSAGES) {
    return { tier: 'strong', reason: 'long' };
  }
  return { tier: 'fast', reason: 'plain' };
}

/**
 * The stronger model to pair with a configured one: Nova Pro, called the same
 * way (the same inference profile prefix, or in-region). Null when the
 * configured model is already Nova Pro, so there is nothing to route to.
 */
export function strongModelFor(modelId) {
  const match = /^((?:[a-z]+\.)?amazon\.nova-)(micro|lite|pro)(-v1:0)$/.exec(modelId || '');
  if (!match || match[2] === 'pro') return null;
  return `${match[1]}pro${match[3]}`;
}

/**
 * The routing a deployment asked for, checked: `{ strongModelId }` when it can
 * route, or `{ problem }` saying why not. Routing that cannot be set up never
 * stops chat: the caller keeps the one configured model.
 */
export function resolveRouting({ enabled, region, modelId, strongModelId }) {
  if (!enabled) return { strongModelId: null };
  const strong = strongModelId || strongModelFor(modelId);
  if (!strong) return { strongModelId: null, problem: 'the configured model is already the strongest; nothing to route to' };
  if (strong === modelId) return { strongModelId: null, problem: 'the strong model is the configured model' };
  try {
    validateBedrockConfig({ region, modelId: strong });
  } catch (error) {
    return { strongModelId: null, problem: error.message };
  }
  return { strongModelId: strong };
}
