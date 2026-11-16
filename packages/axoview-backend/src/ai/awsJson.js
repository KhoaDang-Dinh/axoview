/**
 * Signed JSON calls to AWS APIs that have no SDK client in this package
 * (Bedrock InvokeModel, S3 Vectors), using the SDK's credential chain (EKS Pod
 * Identity) and Smithy's SigV4 signer, as bedrock.js does. Never logs request
 * bodies, credentials or responses.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from './bedrock.js';

const REGION_RE = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/;

/**
 * createAwsJsonClient({ region, service, hostname }) -> call(path, body) -> parsed JSON
 * (null for an empty 200). A non-2xx response throws with `status` and the AWS
 * error type (from x-amzn-errortype), never the body.
 */
export function createAwsJsonClient({ region, service, hostname, credentials, fetchImpl = fetch, timeoutMs = 15_000 }) {
  if (!REGION_RE.test(region || '')) throw new Error(`Invalid region for ${service}`);
  const credentialClient = credentials ? null : new DynamoDBClient({ region });
  const signer = new SignatureV4({
    service,
    region,
    credentials: credentials || credentialClient.config.credentials,
    sha256: Sha256
  });
  return async function call(path, payload) {
    const body = JSON.stringify(payload);
    const signed = await signer.sign({
      protocol: 'https:', hostname, method: 'POST', path,
      headers: { host: hostname, 'content-type': 'application/json', accept: 'application/json' },
      body
    });
    const response = await fetchImpl(`https://${hostname}${path}`, {
      method: 'POST', headers: signed.headers, body, signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) {
      const type = (response.headers?.get?.('x-amzn-errortype') || '').split(':')[0] || 'Error';
      throw Object.assign(new Error(`${service} ${path} HTTP ${response.status} ${type}`),
        { status: response.status, awsType: type });
    }
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  };
}
