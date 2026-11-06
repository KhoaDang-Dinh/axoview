import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AssistantWidget } from '../AssistantWidget';
import { useAssistantStore } from '../../../stores/assistantStore';
import { useAssistantPageStore } from '../../../stores/assistantPageStore';
import { useCognitoSessionStore } from '../../../stores/cognitoSessionStore';

// One storage value per test, the same object on every render (a fresh object
// per render re-runs the widget's effects).
let storage: { isInitialized: boolean; runtimeConfig: unknown };
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

const mockDescribe = jest.fn();
const mockPlan = jest.fn();
jest.mock('axoview', () => ({
  diagramAgent: {
    describeDiagram: (...args: unknown[]) => mockDescribe(...args),
    planOperations: (...args: unknown[]) => mockPlan(...args)
  }
}));

type Ai = Partial<{ chatEnabled: boolean; liveChat: boolean; guestEnabled: boolean; diagramContextEnabled: boolean }>;

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
  useAssistantPageStore.setState({ readPage: null });
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
});
