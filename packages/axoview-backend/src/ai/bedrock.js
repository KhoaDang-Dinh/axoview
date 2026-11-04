/**
 * AWS Bedrock Converse (non-streaming Phase 2).
 *
 * Uses the existing AWS SDK v3 credential chain (EKS Pod Identity) plus its
 * Smithy SigV4 signer. This avoids a second SDK dependency/lockfile tree;
 * no application AWS keys or model tokens are stored in the repository.
 * Phase 3 will replace this HTTP exchange with ConverseStream.
 */
import { createHash, createHmac } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SignatureV4 } from '@smithy/signature-v4';

// SignatureV4's hash constructor is also used for HMAC signing-key derivation.
export class Sha256 {
  constructor(secret) {
    this.hash = secret ? createHmac('sha256', Buffer.from(secret)) : createHash('sha256');
  }
  update(data) { this.hash.update(data); }
  async digest() { return this.hash.digest(); }
}

const REGION_RE = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/;
// A Nova text model, called directly or through a cross-region inference
// profile (geo prefix). Many regions only offer Nova through a profile:
// ap-southeast-1 has no in-region Nova Lite, only apac.amazon.nova-lite-v1:0.
const MODEL_RE = /^(?:(?:us|eu|apac|ca|jp|au)\.)?amazon\.nova-(?:micro|lite|pro)-v1:0$/;
export const DEFAULT_AI_MODEL_ID = 'amazon.nova-lite-v1:0';
const GEO_PROFILE = { ap: 'apac', eu: 'eu', us: 'us', ca: 'ca' };

/** The Nova Lite ID to use in a region when none is configured: its geo inference profile. */
export function defaultModelFor(region) {
  const value = String(region || '');
  if (value.includes('-gov-')) return DEFAULT_AI_MODEL_ID;
  const geo = GEO_PROFILE[value.split('-')[0]];
  return geo ? `${geo}.${DEFAULT_AI_MODEL_ID}` : DEFAULT_AI_MODEL_ID;
}

export function validateBedrockConfig({ region, modelId }) {
  if (!REGION_RE.test(region || '')) throw new Error('Invalid Bedrock region configuration');
  if (!MODEL_RE.test(modelId || '')) {
    throw new Error('Use an approved Amazon Nova text model ID (amazon.nova-*-v1:0, or its us./eu./apac./ca./jp./au. inference profile)');
  }
}

export function createNovaClient({
  region,
  modelId = defaultModelFor(region),
  fetchImpl = fetch,
  credentials,
  timeoutMs = 30_000
}) {
  validateBedrockConfig({ region, modelId });
  const credentialClient = credentials ? null : new DynamoDBClient({ region });
  const signer = new SignatureV4({
    service: 'bedrock',
    region,
    credentials: credentials || credentialClient.config.credentials,
    sha256: Sha256
  });
  const hostname = `bedrock-runtime.${region}.amazonaws.com`;
  const path = `/model/${encodeURIComponent(modelId)}/converse`;

  return async function invokeNova(messages) {
    const body = JSON.stringify({
      messages: messages.map(({ role, text }) => ({ role, content: [{ text }] })),
      system: [{ text: 'You are the Axoview assistant. Answer general questions concisely. You currently have no access to diagrams, files, external tools, or private workspace data. Do not claim otherwise.' }],
      inferenceConfig: { maxTokens: 384, temperature: 0.3 }
    });
    const signed = await signer.sign({
      protocol: 'https:',
      hostname,
      method: 'POST',
      path,
      headers: {
        host: hostname,
        'content-type': 'application/json'
      },
      body
    });
    const response = await fetchImpl(`https://${hostname}${path}`, {
      method: 'POST',
      headers: signed.headers,
      body,
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) {
      // Never print request body, credentials, user prompts or model response.
      const err = new Error(`Bedrock Converse HTTP ${response.status}`);
      err.status = 503;
      throw err;
    }
    const result = await response.json();
    const text = result?.output?.message?.content
      ?.filter((block) => typeof block?.text === 'string')
      .map((block) => block.text).join('\n') || '';
    if (!text) {
      const err = new Error('Bedrock returned no text');
      err.status = 502;
      throw err;
    }
    return {
      text: text.slice(0, 6000),
      usage: {
        inputTokens: Math.max(0, Number(result.usage?.inputTokens) || 0),
        outputTokens: Math.max(0, Number(result.usage?.outputTokens) || 0)
      }
    };
  };
}
