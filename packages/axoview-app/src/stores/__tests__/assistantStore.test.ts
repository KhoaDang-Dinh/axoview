import {
  AI_CONNECTORS,
  clampBubblePosition,
  findAiConnector,
  useAssistantStore
} from '../assistantStore';

describe('Phase 1 assistant state', () => {
  beforeEach(() => {
    useAssistantStore.setState({ open: false, identity: null, messages: [], nextId: 1, view: 'chat' });
  });

  test('provider families contain all six clients, without combining credentials', () => {
    expect(AI_CONNECTORS.map((provider) => provider.label)).toEqual(['OpenAI', 'Anthropic', 'Google']);
    expect(findAiConnector('codex')?.family).toBe('OpenAI');
    expect(findAiConnector('claude-code')?.family).toBe('Anthropic');
    expect(findAiConnector('gemini-cli')?.family).toBe('Google');
    expect(findAiConnector('unrecognized')).toBeUndefined();
  });

  test('bubble remains visible inside viewport even after resize', () => {
    expect(clampBubblePosition({ x: -400, y: 900 }, 320, 240)).toEqual({ x: 12, y: 172 });
    expect(clampBubblePosition({ x: 100, y: 100 }, 50, 50)).toEqual({ x: 12, y: 12 });
  });

  test('mock messages are scoped to the active identity', () => {
    const store = useAssistantStore.getState();
    store.activateIdentity('guest');
    store.openChat();
    useAssistantStore.getState().sendMockMessage('Explain this diagram');
    expect(useAssistantStore.getState().messages).toHaveLength(2);
    useAssistantStore.getState().activateIdentity('user:alpha');
    expect(useAssistantStore.getState().messages).toEqual([]);
    expect(useAssistantStore.getState().open).toBe(false);
    useAssistantStore.getState().sendMockMessage('private prompt');
    useAssistantStore.getState().activateIdentity('guest');
    expect(useAssistantStore.getState().messages).toEqual([]);
  });

  test('cannot add empty messages and caps prompt length', () => {
    useAssistantStore.getState().sendMockMessage('   ');
    expect(useAssistantStore.getState().messages).toHaveLength(0);
    useAssistantStore.getState().sendMockMessage('x'.repeat(3000));
    expect(useAssistantStore.getState().messages[0].text).toHaveLength(2000);
  });
});
