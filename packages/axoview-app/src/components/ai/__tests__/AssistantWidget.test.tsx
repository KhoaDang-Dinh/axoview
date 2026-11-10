import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AssistantWidget } from '../AssistantWidget';
import { useAssistantStore } from '../../../stores/assistantStore';
import { useAssistantPageStore } from '../../../stores/assistantPageStore';
import { useCognitoSessionStore } from '../../../stores/cognitoSessionStore';

// One storage value per test, the same object on every render (a fresh object
// per render re-runs the widget's effects).
let storage: { isInitialized: boolean; runtimeConfig: unknown; storage?: unknown; serverStorageAvailable?: boolean };
jest.mock('../../../providers/AppStorageContext', () => ({
  useAppStorage: () => storage
}));

// react-router does not load under jsdom here (TextEncoder); the widget only
// reads the path. Stable objects: a new one per render re-runs its effects.
const mockLocation = { pathname: '/', search: '', key: 'k' };
const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  useLocation: () => mockLocation,
  useNavigate: () => mockNavigate
}));

const mockApiFetch = jest.fn();
jest.mock('../../../services/apiFetch', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args)
}));

const mockPush = jest.fn();
jest.mock('../../../stores/notificationStore', () => ({
  notificationStore: { push: (n: unknown) => mockPush(n) }
}));

const mockDescribe = jest.fn();
const mockPlan = jest.fn();
jest.mock('axoview', () => ({
  diagramAgent: {
    describeDiagram: (...args: unknown[]) => mockDescribe(...args),
    planOperations: (...args: unknown[]) => mockPlan(...args)
  }
}));

type Ai = Partial<{
  chatEnabled: boolean; liveChat: boolean; guestEnabled: boolean; diagramContextEnabled: boolean; agentWriteEnabled: boolean;
}>;

function setConfig(ai: Ai) {
  storage = { isInitialized: true, runtimeConfig: { ai: { chatEnabled: true, ...ai } } };
}

function signIn() {
  useCognitoSessionStore.setState({ status: 'signed-in', user: { sub: 'u1' }, accessToken: 't', expiresAt: Date.now() + 3_600_000 });
}

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

function renderOpen() {
  act(() => useAssistantStore.getState().openChat());
  return render(<AssistantWidget />);
}

async function send(text: string) {
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
}

const sentBodies = () => mockApiFetch.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));

beforeAll(() => {
  // jsdom has no layout: the widget scrolls the newest message into view.
  Element.prototype.scrollIntoView = jest.fn();
});

beforeEach(() => {
  mockApiFetch.mockReset();
  mockDescribe.mockReset();
  mockPlan.mockReset();
  useCognitoSessionStore.setState({ status: 'signed-out', user: null, accessToken: null, expiresAt: 0, error: null });
  useAssistantStore.setState({ open: false, view: 'chat', messages: [], nextId: 1 });
  useAssistantPageStore.setState({ readPage: null, applyToPage: null, canChangePage: null });
  mockPush.mockReset();
});

describe('AssistantWidget', () => {
  test('renders nothing when the deployment has chat off', () => {
    setConfig({ chatEnabled: false, guestEnabled: true });
    renderOpen();
    expect(screen.queryByRole('region', { name: 'Axoview AI assistant' })).toBeNull();
  });

  test('renders nothing for a guest unless guests are allowed', () => {
    setConfig({ liveChat: true });
    renderOpen();
    expect(screen.queryByRole('region', { name: 'Axoview AI assistant' })).toBeNull();
  });

  test('a guest gets the canned preview and nothing is sent, even with live chat on', async () => {
    setConfig({ liveChat: true, guestEnabled: true });
    renderOpen();
    expect(screen.getByText(/Guest preview only/)).toBeTruthy();
    await send('hello');
    expect(screen.getByText(/Phase 1 preview/)).toBeTruthy();
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  test('signed in: posts the message, then continues the same conversation; keeps valid sources only', async () => {
    setConfig({ liveChat: true });
    signIn();
    mockApiFetch.mockResolvedValue(jsonResponse(200, {
      reply: 'Press C.', conversationId: 'c1',
      sources: [{ id: 'a', title: 'Connecting two items' }, { id: 7, title: 'bad' }, null]
    }));
    renderOpen();

    await send('How do I connect?');
    await screen.findByText('Press C.');
    expect(screen.getByText('From the manual: Connecting two items')).toBeTruthy();
    await send('And then?');
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(2));
    expect(mockApiFetch.mock.calls[0][0]).toBe('/api/ai/messages');
    expect(sentBodies()).toEqual([
      { message: 'How do I connect?' },
      { message: 'And then?', conversationId: 'c1' }
    ]);
  });

  test("shows the server's error, and a generic one for a non-JSON page; keeps the draft", async () => {
    setConfig({ liveChat: true });
    signIn();
    mockApiFetch.mockResolvedValueOnce(jsonResponse(429, { error: 'Daily limit reached.' }));
    renderOpen();
    await send('hi');
    expect((await screen.findByRole('alert')).textContent).toBe('Daily limit reached.');
    expect((screen.getByLabelText('Message') as HTMLInputElement).value).toBe('hi');

    mockApiFetch.mockResolvedValueOnce({ ok: false, status: 502, json: async () => { throw new SyntaxError('Unexpected token <'); } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('AI chat is unavailable'));

    mockApiFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Failed to fetch'));
  });

  test('signing out drops the draft and the conversation; the next message is not sent', async () => {
    setConfig({ liveChat: true, guestEnabled: true });
    signIn();
    mockApiFetch.mockResolvedValue(jsonResponse(200, { reply: 'Private answer.', conversationId: 'c1', sources: [] }));
    renderOpen();
    await send('private question');
    await screen.findByText('Private answer.');
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'unsent draft' } });

    act(() => useCognitoSessionStore.setState({ status: 'signed-out', user: null, accessToken: null }));

    expect(screen.queryByText('Private answer.')).toBeNull();
    expect(screen.queryByText('private question')).toBeNull();
    expect((screen.getByLabelText('Message') as HTMLInputElement).value).toBe('');
    expect(screen.getByText(/Guest preview only/)).toBeTruthy();
    await send('as a guest');
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
  });

  describe('"Include this page"', () => {
    const page = { model: { title: 'D', items: [], views: [] }, viewId: 'v1' };

    test('is offered only with diagram context on and an editor open', () => {
      setConfig({ liveChat: true });
      signIn();
      useAssistantPageStore.setState({ readPage: () => page as never });
      const { unmount } = renderOpen();
      expect(screen.queryByLabelText(/Include this page/)).toBeNull();
      unmount();

      setConfig({ liveChat: true, diagramContextEnabled: true });
      useAssistantPageStore.setState({ readPage: null });
      renderOpen();
      expect(screen.queryByLabelText(/Include this page/)).toBeNull();
    });

    test('sends the page only when ticked, and plans the suggestions against it', async () => {
      setConfig({ liveChat: true, diagramContextEnabled: true });
      signIn();
      const readPage = jest.fn(() => page as never);
      useAssistantPageStore.setState({ readPage });
      mockDescribe.mockReturnValue({ page: { id: 'v1', name: 'Page 1' }, nodes: [] });
      mockPlan.mockReturnValue([
        { index: 0, status: 'ready', summary: 'Add “Web”', howTo: 'Press N.', manualSection: 'x', nodeIds: [] }
      ]);
      const suggestions = [{ op: 'add_node', name: 'Web' }];
      mockApiFetch.mockResolvedValue(jsonResponse(200, { reply: 'Ok.', conversationId: 'c1', sources: [], suggestions }));
      renderOpen();

      await send('unticked');
      await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(1));
      expect(readPage).not.toHaveBeenCalled();
      expect(sentBodies()[0]).toEqual({ message: 'unticked' });
      // Suggestions without a page are not shown.
      await screen.findByText('Ok.');
      expect(screen.queryByText('Add “Web”')).toBeNull();

      fireEvent.click(screen.getByLabelText(/Include this page/));
      await send('ticked');
      await screen.findByText('Add “Web”');
      expect(sentBodies()[1]).toEqual({
        message: 'ticked', conversationId: 'c1', diagram: { page: { id: 'v1', name: 'Page 1' }, nodes: [] }
      });
      expect(mockDescribe).toHaveBeenCalledWith(page.model, { viewId: 'v1' });
      expect(mockPlan).toHaveBeenCalledWith(page.model, 'v1', suggestions);
    });

    test('ticked with no diagram open: asks the user instead of sending', async () => {
      setConfig({ liveChat: true, diagramContextEnabled: true });
      signIn();
      useAssistantPageStore.setState({ readPage: () => null });
      renderOpen();
      fireEvent.click(screen.getByLabelText(/Include this page/));
      await send('anything');
      expect((await screen.findByRole('alert')).textContent).toMatch(/Open a diagram first/);
      expect(mockApiFetch).not.toHaveBeenCalled();
    });
  });

  describe('what Nova may do (an agent on its person\'s account)', () => {
    const page = { model: { title: 'D', items: [], views: [] }, viewId: 'v1' };
    const step = (index: number, summary: string, status = 'ready', problem?: string) =>
      ({ index, status, summary, howTo: 'by hand', manualSection: 'x', nodeIds: [] as string[], ...(problem ? { problem } : {}) });

    function setup({ level = 'proposer', canChange = true } = {}) {
      setConfig({ liveChat: true, diagramContextEnabled: true, agentWriteEnabled: true });
      const agent = {
        agentLevel: jest.fn(async () => level),
        setAgentLevel: jest.fn(async () => true)
      };
      storage = { ...storage, storage: agent, serverStorageAvailable: true };
      signIn();
      const applyToPage = jest.fn((ops: unknown[]) => ops.map((_, k) => step(k, `done ${k}`)));
      useAssistantPageStore.setState({ readPage: () => page as never, applyToPage: applyToPage as never, canChangePage: () => canChange });
      mockDescribe.mockReturnValue({ page: { id: 'v1', name: 'Page 1' }, nodes: [] });
      return { agent, applyToPage };
    }

    async function askForSuggestions(suggestions: unknown[], plan: unknown[]) {
      mockPlan.mockReturnValue(plan);
      mockApiFetch.mockResolvedValue(jsonResponse(200, { reply: 'Here.', conversationId: 'c1', sources: [], suggestions }));
      fireEvent.click(screen.getByLabelText(/Include this page/));
      await send('improve it');
      await screen.findByText('Here.');
    }

    test('off unless the deployment allows agent writes and keeps accounts on the server', () => {
      setConfig({ liveChat: true, diagramContextEnabled: true });
      storage = { ...storage, storage: { agentLevel: jest.fn(async () => 'proposer') }, serverStorageAvailable: true };
      signIn();
      useAssistantPageStore.setState({ readPage: () => page as never, canChangePage: () => true });
      const { unmount } = renderOpen();
      expect(document.querySelector('[data-axoview-id="ai-agent-level"]')).toBeNull();
      unmount();

      setConfig({ liveChat: true, diagramContextEnabled: true, agentWriteEnabled: true });
      storage = { ...storage, storage: { agentLevel: jest.fn(async () => 'proposer') }, serverStorageAvailable: false };
      renderOpen();
      expect(document.querySelector('[data-axoview-id="ai-agent-level"]')).toBeNull();
    });

    test('Read only (the default): suggestions stay a checklist to do by hand', async () => {
      const { applyToPage } = setup({ level: 'viewer' });
      renderOpen();
      await askForSuggestions([{ op: 'add_node', name: 'Web' }], [step(0, 'Add “Web”')]);
      expect(screen.getByText(/make them yourself/)).toBeTruthy();
      expect(screen.queryByLabelText('Approve: Add “Web”')).toBeNull();
      expect(applyToPage).not.toHaveBeenCalled();
    });

    test('"Changes need my approval": approving a step makes it on the page, once, and it shows as done', async () => {
      const { agent, applyToPage } = setup();
      renderOpen();
      await waitFor(() => expect(agent.agentLevel).toHaveBeenCalled());
      const suggestions = [{ op: 'add_node', name: 'Web' }, { op: 'add_node', name: 'Db' }];
      await askForSuggestions(suggestions, [step(0, 'Add “Web”'), step(1, 'Add “Db”')]);
      // After the approval, the rest is re-checked against the changed page.
      mockPlan.mockReturnValue([step(0, 'Add “Db”')]);
      fireEvent.click(await screen.findByLabelText('Approve: Add “Web”'));
      expect(applyToPage).toHaveBeenCalledWith([suggestions[0]], 'v1');
      expect(mockPlan).toHaveBeenLastCalledWith(page.model, 'v1', [suggestions[1]]);
      expect(mockPush).toHaveBeenCalledWith({ severity: 'success', message: 'Change approved and made' });
      expect(document.querySelector('[data-axoview-id="ai-suggestion-0"]')?.getAttribute('data-status')).toBe('applied');
      expect(screen.getByLabelText('Approve: Add “Db”')).toBeTruthy();
    });

    test('a step that no longer applies is not made, and says why', async () => {
      const { applyToPage } = setup();
      applyToPage.mockReturnValueOnce([step(0, 'Connect', 'not_applicable', 'No item named “Cache”')]);
      renderOpen();
      await askForSuggestions([{ op: 'connect', from: { name: 'Web' }, to: { name: 'Cache' } }], [step(0, 'Connect')]);
      fireEvent.click(await screen.findByLabelText('Approve: Connect'));
      expect(mockPush).toHaveBeenCalledWith({ severity: 'error', message: 'Not changed: No item named “Cache”' });
      expect(document.querySelector('[data-axoview-id="ai-suggestion-0"]')?.getAttribute('data-status')).toBe('ready');
    });

    test('on a diagram the person may only view, Nova is Read only too', async () => {
      const { applyToPage } = setup({ canChange: false });
      renderOpen();
      expect(await screen.findByText(/Read only here, like you/)).toBeTruthy();
      await askForSuggestions([{ op: 'add_node', name: 'Web' }], [step(0, 'Add “Web”')]);
      expect(screen.queryByLabelText('Approve: Add “Web”')).toBeNull();
      expect(applyToPage).not.toHaveBeenCalled();
    });

    test('changing the level saves it for the account; a failed save goes back, in red', async () => {
      const { agent } = setup({ level: 'viewer' });
      agent.setAgentLevel.mockResolvedValueOnce(false);
      renderOpen();
      await waitFor(() => expect(agent.agentLevel).toHaveBeenCalled());
      fireEvent.mouseDown(screen.getByLabelText('What Nova may do'));
      fireEvent.click(await screen.findByText('Changes need my approval'));
      await waitFor(() => expect(agent.setAgentLevel).toHaveBeenCalledWith('proposer'));
      await waitFor(() => expect(mockPush).toHaveBeenCalledWith({ severity: 'error', message: "Couldn't change what Nova may do: try again" }));
      expect(screen.getByLabelText('What Nova may do').textContent).toContain('Read only');
    });
  });
});
