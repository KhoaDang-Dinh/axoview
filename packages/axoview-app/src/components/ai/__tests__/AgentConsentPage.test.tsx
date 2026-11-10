/**
 * The consent page an outside agent's sign-in brings the person to (ADR 0059):
 * which app asks, where it goes back to (a warning for an app on this
 * computer), what it may do, and Allow / Deny sending the browser back.
 * Also the connected-apps list where it can be narrowed or disconnected.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';

const mockApiFetch = jest.fn();
jest.mock('../../../services/apiFetch', () => ({ apiFetch: (...args: unknown[]) => mockApiFetch(...args) }));
let mockParams = new URLSearchParams('request=abcdefghijklmnopqrstuvwx');
jest.mock('react-router-dom', () => ({ useSearchParams: () => [mockParams] }));
jest.mock('../../../utils/bootScreen', () => ({ dismissBootScreens: () => {} }));
const pushes: Array<{ severity: string; message: string }> = [];
jest.mock('../../../stores/notificationStore', () => ({
  notificationStore: { push: (n: { severity: string; message: string }) => pushes.push(n) }
}));

import { AgentConsentPage } from '../AgentConsentPage';
import { ConnectedApps } from '../ConnectedApps';
import { useCognitoSessionStore } from '../../../stores/cognitoSessionStore';

const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;
const REQUEST = {
  clientName: 'Claude Code', clientHost: null, registration: 'dynamic', redirectHost: '127.0.0.1:61999', loopback: true,
  scopes: ['diagrams:read', 'diagrams:propose']
};
const sent = () => mockApiFetch.mock.calls.map(([url, init]) => [url, init?.method ?? 'GET', init?.body ? JSON.parse(init.body) : undefined]);

beforeEach(() => {
  mockApiFetch.mockReset();
  pushes.length = 0;
  mockParams = new URLSearchParams('request=abcdefghijklmnopqrstuvwx');
  useCognitoSessionStore.setState({ status: 'signed-in', user: { sub: 'alice-1', email: 'alice@example.com' } as never });
});

async function open(go = jest.fn()) {
  await act(async () => { render(<AgentConsentPage go={go} />); });
  return go;
}

it('names the app, says it registered itself, where it goes back to, and warns about an app on this computer', async () => {
  mockApiFetch.mockResolvedValueOnce(json(200, REQUEST));
  await open();
  expect(screen.getByText('Connect Claude Code to Axoview?')).toBeTruthy();
  expect(screen.getByText(/as you \(alice@example.com\)/)).toBeTruthy();
  expect(document.querySelector('[data-axoview-id="agent-consent-from"]')?.textContent)
    .toBe('It registered itself; Axoview cannot confirm who made it. It goes back to 127.0.0.1:61999.');
  expect(document.querySelector('[data-axoview-id="agent-consent-loopback"]')).toBeTruthy();
  expect(sent()[0]).toEqual(['/api/oauth/requests/abcdefghijklmnopqrstuvwx', 'GET', undefined]);
});

it('a client identified by its metadata URL shows that host, with no warning for an https return', async () => {
  mockApiFetch.mockResolvedValueOnce(json(200, { ...REQUEST, clientHost: 'claude.ai', registration: 'metadata', redirectHost: 'claude.ai', loopback: false }));
  await open();
  expect(document.querySelector('[data-axoview-id="agent-consent-from"]')?.textContent)
    .toBe('Identified by claude.ai. It goes back to claude.ai.');
  expect(document.querySelector('[data-axoview-id="agent-consent-loopback"]')).toBeNull();
});

it('Allow with proposing ticked, or unticked; Deny; each sends the browser back', async () => {
  mockApiFetch.mockResolvedValueOnce(json(200, REQUEST)).mockResolvedValueOnce(json(200, { redirect: 'http://127.0.0.1:61999/callback?code=c' }));
  const go = await open();
  await act(async () => { fireEvent.click(document.querySelector('[data-axoview-id="agent-consent-allow"]')!); });
  expect(sent()[1]).toEqual(['/api/oauth/requests/abcdefghijklmnopqrstuvwx', 'POST', { approve: true, scopes: ['diagrams:propose'] }]);
  expect(go).toHaveBeenCalledWith('http://127.0.0.1:61999/callback?code=c');
  expect(screen.getByText('Done. You can go back to your AI app.')).toBeTruthy();
});

it('unticking "propose changes" connects it read-only', async () => {
  mockApiFetch.mockResolvedValueOnce(json(200, REQUEST)).mockResolvedValueOnce(json(200, { redirect: 'http://127.0.0.1:61999/cb?code=c' }));
  await open();
  fireEvent.click(screen.getByLabelText('Let it propose changes'));
  await act(async () => { fireEvent.click(document.querySelector('[data-axoview-id="agent-consent-allow"]')!); });
  expect(sent()[1][2]).toEqual({ approve: true, scopes: [] });
});

it('Deny', async () => {
  mockApiFetch.mockResolvedValueOnce(json(200, REQUEST)).mockResolvedValueOnce(json(200, { redirect: 'http://127.0.0.1:61999/cb?error=access_denied' }));
  const go = await open();
  await act(async () => { fireEvent.click(document.querySelector('[data-axoview-id="agent-consent-deny"]')!); });
  expect(sent()[1][2]).toEqual({ approve: false });
  expect(go).toHaveBeenCalledWith('http://127.0.0.1:61999/cb?error=access_denied');
});

it('an expired or used request says to start again', async () => {
  mockApiFetch.mockResolvedValueOnce(json(404, { reason: 'expired' }));
  await open();
  expect(document.querySelector('[data-axoview-id="agent-consent-expired"]')).toBeTruthy();
});

describe('connected apps', () => {
  const GRANT = {
    id: 'a'.repeat(32), clientId: 'dcr_x', clientName: 'Claude Code', scopes: ['diagrams:read', 'diagrams:propose'],
    redirectHost: '127.0.0.1:61999', createdAt: '2026-11-10T00:00:00Z', updatedAt: '2026-11-10T00:00:00Z'
  };

  it('lists each app; turning off proposing narrows it; Disconnect removes it', async () => {
    mockApiFetch
      .mockResolvedValueOnce(json(200, { grants: [GRANT] }))
      .mockResolvedValueOnce(json(200, { grant: { ...GRANT, scopes: ['diagrams:read'] } }))
      .mockResolvedValueOnce(json(200, { removed: GRANT.id }));
    await act(async () => { render(<ConnectedApps />); });
    const toggle = screen.getByLabelText('Claude Code may propose changes') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    await act(async () => { fireEvent.click(toggle); });
    expect(sent()[1]).toEqual([`/api/oauth/grants/${GRANT.id}`, 'PATCH', { scopes: [] }]);
    expect((screen.getByLabelText('Claude Code may propose changes') as HTMLInputElement).checked).toBe(false);
    await act(async () => { fireEvent.click(screen.getByLabelText('Disconnect Claude Code')); });
    expect(sent()[2]).toEqual([`/api/oauth/grants/${GRANT.id}`, 'DELETE', undefined]);
    expect(document.querySelector('[data-axoview-id="ai-connected-app"]')).toBeNull();
    expect(pushes.at(-1)).toEqual({ severity: 'success', message: 'Claude Code is disconnected' });
  });

  it('none yet', async () => {
    mockApiFetch.mockResolvedValueOnce(json(200, { grants: [] }));
    await act(async () => { render(<ConnectedApps />); });
    expect(screen.getByText(/None yet/)).toBeTruthy();
  });
});
