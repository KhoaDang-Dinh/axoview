/**
 * A diagram deleted in another tab of this browser closes here at once, and
 * the URL goes back to /app; pending edits are saved before a sign-out.
 */
import { act, waitFor } from '@testing-library/react';

let syncOptions: { reloadOpenDiagram: () => Promise<void> } | null = null;
jest.mock('../../hooks/useRealtimeSync', () => ({
  useRealtimeSync: (options: { reloadOpenDiagram: () => Promise<void> }) => { syncOptions = options; }
}));

let tabHandler: ((message: { type: string; id?: string }) => void) | null = null;
jest.mock('../../services/sync/tabChannel', () => ({
  postToTabs: jest.fn(),
  onTabMessage: (handler: (message: { type: string; id?: string }) => void) => {
    tabHandler = handler;
    return () => { tabHandler = null; };
  }
}));

// A minimal router: navigate() records the call and moves the location, as
// the real one does (without re-rendering: assertions read the calls).
let mockLocation = { pathname: '/', search: '' };
const navigations: Array<{ to: string; replace: boolean }> = [];
const mockNavigate = (to: string, opts?: { replace?: boolean }) => {
  navigations.push({ to, replace: !!opts?.replace });
  const [pathname, query] = to.split('?');
  mockLocation = { pathname, search: query ? `?${query}` : '' };
};
jest.mock('react-router-dom', () => ({
  useParams: () => {
    const match = /^\/d\/([^/]+)$/.exec(mockLocation.pathname);
    return match ? { diagramId: decodeURIComponent(match[1]) } : {};
  },
  useNavigate: () => mockNavigate,
  useLocation: () => ({ ...mockLocation, hash: '', state: null, key: 'k' })
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'en' }
  })
}));
jest.mock('@isoflow/isopacks/dist/utils', () => ({ flattenCollections: () => [] }));
jest.mock('@isoflow/isopacks/dist/isoflow', () => ({}), { virtual: true });
jest.mock('../../services/iconPackManager', () => ({
  useIconPackManager: () => ({
    loadedIcons: [], getLoadedIcons: () => [], loadPacksForDiagram: async () => {},
    togglePack: () => {}, toggleLazyLoading: () => {}, lazyLoadingEnabled: false, packInfo: {}, enabledPacks: []
  })
}));
jest.mock('../../hooks/useRuntimeConfig', () => ({
  fetchRuntimeConfig: async () => ({ serverStorage: true, drivePublicPreview: false })
}));
jest.mock('../../services/drive/drivePublicRead', () => ({
  readDriveDisplayFile: async () => ({ ok: false, reason: 'not-found' })
}));
let appStorage: Record<string, unknown> = {};
jest.mock('../AppStorageContext', () => ({
  useAppStorage: () => appStorage,
  AppStorageProvider: ({ children }: { children: unknown }) => children
}));

import { renderLifecycle, appStorageValue, makeStorage } from '../../testUtils/lifecycleHarness';
import { notificationStore } from '../../stores/notificationStore';

const TWO_PAGES = {
  title: 'Two pages',
  items: [],
  views: [
    { id: 'overview', name: 'Overview', items: [], connectors: [], rectangles: [], textBoxes: [] },
    { id: 'details', name: 'Details', items: [], connectors: [], rectangles: [], textBoxes: [] }
  ]
};

import { runBeforeSignOut } from '../../services/session/beforeSignOut';

let toasts: Array<{ severity: string; message: string }>;
beforeEach(() => {
  mockLocation = { pathname: '/', search: '' };
  navigations.length = 0;
  localStorage.clear();
  toasts = [];
  jest.spyOn(notificationStore, 'push').mockImplementation((n) => {
    toasts.push(n as { severity: string; message: string });
    return undefined as never;
  });
});
afterEach(() => jest.restoreAllMocks());

const server = (overrides: Parameters<typeof appStorageValue>[0] = {}) =>
  appStorageValue({ serverStorageAvailable: true, remoteStorageActive: true, ...overrides });

async function openTwoPages(storageOverrides = {}) {
  const double = makeStorage({ loadDiagram: async () => TWO_PAGES, ...storageOverrides } as never);
  appStorage = server({ storage: double.storage });
  const h = renderLifecycle();
  await act(async () => { await h.ctx().openDiagramById('abc', 'Two pages'); });
  expect(h.ctx().currentDiagram?.id).toBe('abc');
  return { h, double };
}

describe('deleted in another tab', () => {
  it('the open diagram closes, the user is told, and the URL goes back to /app', async () => {
    const { h } = await openTwoPages();
    await act(async () => { tabHandler!({ type: 'diagram-deleted', id: 'abc' }); });
    expect(h.ctx().currentDiagram).toBeNull();
    expect(toasts).toEqual([expect.objectContaining({ severity: 'warning', message: 'This diagram was deleted in another tab.' })]);
    await waitFor(() => expect(navigations.at(-1)).toEqual({ to: '/', replace: true }));
  });

  it('another diagram deleted: this one stays open, the tree refreshes, no notice', async () => {
    const { h } = await openTwoPages();
    const token = h.ctx().fileTreeRefreshToken;
    await act(async () => { tabHandler!({ type: 'diagram-deleted', id: 'other' }); });
    expect(h.ctx().currentDiagram?.id).toBe('abc');
    expect(h.ctx().fileTreeRefreshToken).toBe(token + 1);
    expect(toasts).toEqual([]);
  });
});

describe('a resync finds the open diagram in the trash', () => {
  it('closes it as deleted instead of showing the trashed copy', async () => {
    let trashed = false;
    const { h } = await openTwoPages({
      loadDiagram: async () => (trashed ? { ...TWO_PAGES, deletedAt: '2026-11-05T10:00:00Z' } : TWO_PAGES)
    });
    trashed = true;
    // What useRealtimeSync calls on a resync: reload the open diagram.
    await act(async () => { await syncOptions!.reloadOpenDiagram(); });
    expect(h.ctx().currentDiagram).toBeNull();
    expect(toasts).toEqual([expect.objectContaining({ severity: 'warning', message: 'This diagram was deleted in another tab or on another device.' })]);
  });
});

describe('signing out', () => {
  it('saves the open diagram\'s pending edits first', async () => {
    const { h, double } = await openTwoPages();
    const model = (title: string) => ({ ...TWO_PAGES, title, icons: [], colors: [] }) as never;
    // The first update after a load is the editor echoing it (ignored); the
    // second is an edit, queued for autosave's debounce.
    act(() => { h.ctx().handleModelUpdated(model('Two pages')); });
    act(() => { h.ctx().handleModelUpdated(model('Edited')); });
    const before = double.saveCalls.length;
    expect(double.saveCalls.map((c) => c.title)).not.toContain('Edited');
    await act(async () => { await runBeforeSignOut(); });
    expect(double.saveCalls.slice(before)).toEqual([{ id: 'abc', title: 'Edited' }]);
  });

  it('nothing open: nothing to save', async () => {
    const double = makeStorage();
    appStorage = server({ storage: double.storage });
    renderLifecycle();
    await act(async () => { await runBeforeSignOut(); });
    expect(double.saveCalls).toEqual([]);
  });
});
