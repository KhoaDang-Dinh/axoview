/**
 * Independent Bedrock ApplyGuardrail checks at every text trust boundary.
 * A guardrail is a probabilistic defense; it does not authorize tool access.
 * Prompt text and returned assessment details are never logged.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from './bedrock.js';

const ID_RE = /^(?:[a-z0-9]{1,64}|arn:aws(?:-[a-z]+)?:bedrock:[a-z0-9-]+:[0-9]{12}:guardrail\/[a-z0-9]+)$/;
const VERSION_RE = /^(?:DRAFT|[1-9][0-9]{0,7})$/;
export class AiSafetyBlocked extends Error {
  constructor(stage) {
    super('Content could not be processed under Axoview safety policy');
    this.name = 'AiSafetyBlocked';
    this.status = 422;
    this.stage = stage;
  }
}

export function assertGuardrailConfig({ guardrailId, guardrailVersion }) {
  if (!ID_RE.test(guardrailId || '') || !VERSION_RE.test(guardrailVersion || '')) {
    throw new Error('AI guardrail ID and version must be configured');
  }
}

export function createGuardrail({
  region,
  guardrailId,
  guardrailVersion,
  fetchImpl = fetch,
  credentials,
  timeoutMs = 15_000
}) {
  assertGuardrailConfig({ guardrailId, guardrailVersion });
  const credentialClient = credentials ? null : new DynamoDBClient({ region });
  const signer = new SignatureV4({
    service: 'bedrock',
    region,
    credentials: credentials || credentialClient.config.credentials,
    sha256: Sha256
  });
  const hostname = `bedrock-runtime.${region}.amazonaws.com`;
  const path = `/guardrail/${encodeURIComponent(guardrailId)}/version/${encodeURIComponent(guardrailVersion)}/apply`;

  return async function inspectText(text, source = 'INPUT') {
    if (source !== 'INPUT' && source !== 'OUTPUT') throw new Error('Invalid guardrail source');
    if (typeof text !== 'string' || text.length === 0 || text.length > 14_000) {
      throw new Error('Unsafe guardrail text length');
    }
    const body = JSON.stringify({
      source,
      content: [{ text: { text } }]
    });
    const signed = await signer.sign({
      protocol: 'https:', hostname, method: 'POST', path,
      headers: { host: hostname, 'content-type': 'application/json' }, body
    });
    const response = await fetchImpl(`https://${hostname}${path}`, {
      method: 'POST',
      headers: signed.headers,
      body,
      signal: AbortSignal.timeout(timeoutMs)
    });
    // Never fall back to unguarded inference on a Bedrock outage/permission issue.
    if (!response.ok) {
      const error = new Error('Bedrock guardrail unavailable');
      error.status = 503;
      throw error;
    }
    const result = await response.json();
    if (result.action === 'GUARDRAIL_INTERVENED') throw new AiSafetyBlocked(source);
    // Unknown response shape also fails closed (do not accept intervention
    // output containing sanitized or blocked private content).
    if (result.action !== 'NONE') throw new Error('Bedrock guardrail response invalid');
    return true;
  };
}

/**
 * Lightweight deterministic tripwire for obvious role-control attempts.
 * False negatives are expected: classification is handled by ApplyGuardrail.
 * Check only instruction-like sequences, not isolated words like 'ignore'.
 */
const ROLE_OVERRIDE = /(?:ignore|override|disregard)\s+(?:all\s+)?(?:previous|prior|system|developer)\s+(?:instructions|rules|prompts)|(?:reveal|print|dump|extract)\s+(?:your\s+)?(?:system|developer)\s+(?:prompt|instructions)|\[\s*(?:system|developer)\s*\]|<\s*(?:system|developer)(?:\s|>)/i;

export function isObviousPromptInjection(text) {
  return typeof text === 'string' && ROLE_OVERRIDE.test(text);
}
