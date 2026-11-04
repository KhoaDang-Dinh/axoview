/**
 * Safe structured telemetry. No prompts, response text, retrieval contents,
 * user IDs, workspace IDs, token values, or client IPs in operational logs.
 */
const KNOWN_STAGES = new Set(['input', 'retrieval', 'model', 'output', 'quota', 'storage', 'completed']);
const KNOWN_RESULTS = new Set(['ok', 'blocked', 'rejected', 'error']);

export function emitAiTelemetry({
  requestId, stage, result,
  latencyMs = 0, inputTokens = 0, outputTokens = 0,
  retrievedDocuments = 0
}, write = (message) => console.log(message)) {
  const record = {
    event: 'ai.request',
    requestId: /^[a-f0-9-]{36}$/i.test(requestId || '') ? requestId : 'unknown',
    stage: KNOWN_STAGES.has(stage) ? stage : 'unknown',
    result: KNOWN_RESULTS.has(result) ? result : 'error',
    latencyMs: Math.max(0, Math.round(Number(latencyMs) || 0)),
    inputTokens: Math.max(0, Math.round(Number(inputTokens) || 0)),
    outputTokens: Math.max(0, Math.round(Number(outputTokens) || 0)),
    retrievedDocuments: Math.min(10, Math.max(0, Math.round(Number(retrievedDocuments) || 0))),
    ts: new Date().toISOString()
  };
  write(JSON.stringify(record));
  return record;
}
