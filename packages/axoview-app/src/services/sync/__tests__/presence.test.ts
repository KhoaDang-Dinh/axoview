import { othersPresent, PRESENCE_TTL_MS, usePresenceStore } from '../presence';
import { getBrowserId, resetBrowserIdForTests } from '../browserId';
import { planSyncReaction } from '../../../hooks/useRealtimeSync';

const event = (action: string, origin: string, browser: string) =>
  ({ seq: 1, kind: 'presence', action, origin, browser }) as const;

beforeEach(() => {
  localStorage.clear();
  resetBrowserIdForTests();
  usePresenceStore.getState().clear();
});

test('another browser joining, renewing, answering or leaving', () => {
  const t0 = 1_000_000;
  expect(othersPresent(t0)).toBe(false);
  usePresenceStore.getState().apply(event('join', 'phone-tab', 'phone-browser') as never, t0);
  expect(othersPresent(t0)).toBe(true);
  usePresenceStore.getState().apply(event('leave', 'phone-tab', 'phone-browser') as never, t0 + 10);
  expect(othersPresent(t0 + 10)).toBe(false);
  usePresenceStore.getState().apply(event('here', 'laptop-tab', 'laptop-browser') as never, t0 + 20);
  expect(othersPresent(t0 + 20)).toBe(true);
});

test('this browser\'s own tabs are not company', () => {
  usePresenceStore.getState().apply(event('join', 'sibling-tab', getBrowserId()) as never);
  expect(othersPresent()).toBe(false);
});

test('a tab not heard from within the TTL is gone (closed without a leave)', () => {
  const t0 = 5_000_000;
  usePresenceStore.getState().apply(event('join', 'phone-tab', 'phone-browser') as never, t0);
  expect(othersPresent(t0 + PRESENCE_TTL_MS - 1)).toBe(true);
  expect(othersPresent(t0 + PRESENCE_TTL_MS + 1)).toBe(false);
  // A renewal keeps it.
  usePresenceStore.getState().apply(event('renew', 'phone-tab', 'phone-browser') as never, t0 + PRESENCE_TTL_MS);
  expect(othersPresent(t0 + PRESENCE_TTL_MS + 1)).toBe(true);
});

test('a tab of another browser leaving does not hide that browser\'s other tab', () => {
  usePresenceStore.getState().apply(event('join', 'phone-tab-1', 'phone-browser') as never);
  usePresenceStore.getState().apply(event('join', 'phone-tab-2', 'phone-browser') as never);
  usePresenceStore.getState().apply(event('leave', 'phone-tab-1', 'phone-browser') as never);
  expect(othersPresent()).toBe(true);
});

test('presence changes nothing on screen', () => {
  expect(planSyncReaction(event('join', 'x-tab-0001', 'x-browser') as never, {
    openDiagramId: 'd1', hasUnsavedWork: false, knownVersion: 1
  })).toEqual({ type: 'ignore' });
});

test('the browser id is shared by the tabs (localStorage) and stable', () => {
  const first = getBrowserId();
  resetBrowserIdForTests();
  expect(getBrowserId()).toBe(first);
  expect(first).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
});
