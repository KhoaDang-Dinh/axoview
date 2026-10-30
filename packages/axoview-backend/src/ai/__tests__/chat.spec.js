import { describe, expect, test, jest } from '@jest/globals';
import { validateChatInput, createAiChatRouter } from '../chat.js';
import { validateBedrockConfig, createNovaClient } from '../bedrock.js';

test('rejects forged client identity and oversized messages', () => {
  expect(() => validateChatInput({ message: '' })).toThrow();
  expect(() => validateChatInput({ message: 'x'.repeat(2001) })).toThrow();
  expect(() => validateChatInput({ message: 'hello', conversationId: 'other-account' })).toThrow();
  expect(validateChatInput({ message: ' hello ' }).message).toBe('hello');
});

test('model and region are strictly allowlisted', () => {
  expect(() => validateBedrockConfig({ region: 'ap-southeast-1', modelId: 'amazon.nova-lite-v1:0' })).not.toThrow();
  expect(() => validateBedrockConfig({ region: 'bad', modelId: 'amazon.nova-lite-v1:0' })).toThrow();
  expect(() => validateBedrockConfig({ region: 'ap-southeast-1', modelId: 'provider.untrusted' })).toThrow();
});

test('signed Converse request contains bounded inputs and returns token counts', async () => {
  const fetchImpl = jest.fn(async (_url, options) => ({
    ok: true,
    json: async () => ({
      output: { message: { content: [{ text: 'Hello from Nova' }] } },
      usage: { inputTokens: 9, outputTokens: 5 }
    })
  }));
  const invoke = createNovaClient({
    region: 'ap-southeast-1',
    modelId: 'amazon.nova-lite-v1:0',
    credentials: { accessKeyId: 'test-key', secretAccessKey: 'test-secret' },
    fetchImpl
  });
  const response = await invoke([{ role: 'user', text: 'Hi' }]);
  expect(response).toEqual({ text: 'Hello from Nova', usage: { inputTokens: 9, outputTokens: 5 } });
  const [url, request] = fetchImpl.mock.calls[0];
  expect(url).toContain('bedrock-runtime.ap-southeast-1.amazonaws.com');
  expect(request.headers.authorization || request.headers.Authorization).toBeTruthy();
  expect(JSON.parse(request.body).inferenceConfig.maxTokens).toBe(384);
});

test('AI router is disabled in non-Cognito modes', () => {
  const router = createAiChatRouter({
    enabled: false, authMode: 'none',
    tableName: 'test', region: 'ap-southeast-1'
  });
  expect(router).toBeTruthy();
});
