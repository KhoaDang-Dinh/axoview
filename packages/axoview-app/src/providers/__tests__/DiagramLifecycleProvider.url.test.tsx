/**
 * The open diagram and page live in the URL (/app/d/<id>?page=<view id>), so
 * a refresh reopens them instead of an empty /app. Server storage only.
 */
import { act, waitFor } from '@testing-library/react';

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

describe('writing the URL', () => {
  it('opening a diagram puts it in the URL, replacing the entry', async () => {
    const loads: string[] = [];
    const double = makeStorage({ loadDiagram: async (id: string) => { loads.push(id); return TWO_PAGES; } } as never);
    appStorage = server({ storage: double.storage });
    const h = renderLifecycle();
    await act(async () => { await h.ctx().openDiagramById('abc', 'Two pages'); });
    expect(loads).toEqual(['abc']);
    expect(navigations.at(-1)).toEqual({ to: '/d/abc', replace: true });
  });

  it('switching page updates ?page=, and only for the open diagram', async () => {
    appStorage = server({ storage: makeStorage({ loadDiagram: async () => TWO_PAGES } as never).storage });
    const h = renderLifecycle();
    act(() => { h.ctx().handleActiveViewChange('details'); });
    expect(navigations).toEqual([]); // no diagram open: the blank canvas's page is not a URL
    await act(async () => { await h.ctx().openDiagramById('abc', 'Two pages'); });
    act(() => { h.ctx().handleActiveViewChange('details'); });
    expect(navigations.at(-1)).toEqual({ to: '/d/abc?page=details', replace: true });
    const before = navigations.length;
    act(() => { h.ctx().handleActiveViewChange('details'); });
    expect(navigations).toHaveLength(before); // same URL: no navigation
  });

  it('ids and page ids are encoded', async () => {
    appStorage = server({ storage: makeStorage({ loadDiagram: async () => TWO_PAGES } as never).storage });
    const h = renderLifecycle();
    await act(async () => { await h.ctx().openDiagramById('abc', 'Two pages'); });
    act(() => { h.ctx().handleActiveViewChange('page one/ä'); });
    expect(navigations.at(-1)?.to).toBe('/d/abc?page=page%20one%2F%C3%A4');
  });

  it('closing the open diagram (deleted elsewhere) goes back to /app, and it is not reopened', async () => {
    let loads = 0;
    appStorage = server({ storage: makeStorage({ loadDiagram: async () => { loads += 1; return TWO_PAGES; } } as never).storage });
    const h = renderLifecycle();
    await act(async () => { await h.ctx().openDiagramById('abc', 'Two pages'); });
    await act(async () => { h.ctx().notifyDiagramDeletedFromTree('abc'); });
    await waitFor(() => expect(navigations.at(-1)).toEqual({ to: '/', replace: true }));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(loads).toBe(1);
    expect(h.ctx().currentDiagram).toBeNull();
  });

  it('a diagram reopened from the URL and then deleted is not reopened either', async () => {
    mockLocation = { pathname: '/d/abc', search: '' };
    let loads = 0;
    appStorage = server({ storage: makeStorage({ loadDiagram: async () => { loads += 1; return TWO_PAGES; } } as never).storage });
    const h = renderLifecycle();
    await waitFor(() => expect(h.ctx().currentDiagram?.id).toBe('abc'));
    await act(async () => { h.ctx().notifyDiagramDeletedFromTree('abc'); });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(loads).toBe(1);
    expect(h.ctx().currentDiagram).toBeNull();
    expect(navigations.at(-1)).toEqual({ to: '/', replace: true });
  });

  it('a Drive diagram or a browser-only session diagram leaves the URL alone', async () => {
    appStorage = server({ activeProviderId: 'google-drive', storage: makeStorage({ loadDiagram: async () => TWO_PAGES } as never).storage });
    const drive = renderLifecycle();
    await act(async () => { await drive.ctx().openDiagramById('drive-file', 'On Drive'); });
    drive.unmount();

    appStorage = appStorageValue({ serverStorageAvailable: false, remoteStorageActive: false });
    const session = renderLifecycle();
    await act(async () => { await session.ctx().openDiagramById('local-1', 'In this browser'); });
    expect(navigations).toEqual([]);
  });
});

describe('reopening from the URL after a refresh', () => {
  it('opens the diagram in the URL on the page in the URL', async () => {
    mockLocation = { pathname: '/d/abc', search: '?page=details' };
    const loads: string[] = [];
    appStorage = server({ storage: makeStorage({ loadDiagram: async (id: string) => { loads.push(id); return TWO_PAGES; } } as never).storage });
    const h = renderLifecycle();
    await waitFor(() => expect(h.ctx().currentDiagram?.id).toBe('abc'));
    expect(loads).toEqual(['abc']);
    // The editor is not mounted in this harness, so the page rides on the data
    // it will mount with.
    expect((h.ctx().frozenInitialDataRef.current as { view?: string } | null)?.view).toBe('details');
    // Never sent to /app while the diagram was loading.
    expect(navigations.filter((n) => n.to === '/')).toEqual([]);
  });

  it('an unknown page opens the first page instead', async () => {
    mockLocation = { pathname: '/d/abc', search: '?page=gone' };
    appStorage = server({ storage: makeStorage({ loadDiagram: async () => TWO_PAGES } as never).storage });
    const h = renderLifecycle();
    await waitFor(() => expect(h.ctx().currentDiagram?.id).toBe('abc'));
    expect((h.ctx().frozenInitialDataRef.current as { view?: string } | null)?.view).toBeUndefined();
  });

  it('a diagram that cannot be loaded (deleted, another account) says so and falls back to /app', async () => {
    mockLocation = { pathname: '/d/gone', search: '' };
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    appStorage = server({ storage: makeStorage({ loadDiagram: async () => { throw new Error('404'); } } as never).storage });
    const h = renderLifecycle();
    await waitFor(() => expect(navigations.at(-1)).toEqual({ to: '/', replace: true }));
    expect(h.ctx().currentDiagram).toBeNull();
    expect(toasts).toEqual([expect.objectContaining({ severity: 'warning', message: expect.stringContaining("can't be opened") })]);
  });

  it('loads it once, even across re-renders while it loads', async () => {
    mockLocation = { pathname: '/d/abc', search: '' };
    let release: () => void = () => {};
    let calls = 0;
    appStorage = server({
      storage: makeStorage({
        loadDiagram: () => { calls += 1; return new Promise((resolve) => { release = () => resolve(TWO_PAGES); }); }
      } as never).storage
    });
    const h = renderLifecycle();
    // Re-render the provider while the load is pending.
    act(() => { h.ctx().setFileExplorerOpen(true); });
    act(() => { h.ctx().setFileExplorerOpen(false); });
    await act(async () => { await Promise.resolve(); });
    expect(calls).toBe(1);
    await act(async () => { release(); });
    await waitFor(() => expect(h.ctx().currentDiagram?.id).toBe('abc'));
    expect(calls).toBe(1);
  });

  it('switches to server storage first when another place is active', async () => {
    mockLocation = { pathname: '/d/abc', search: '' };
    const switched: string[] = [];
    appStorage = server({
      activeProviderId: 'google-drive',
      setActiveProviderId: (id: string) => switched.push(id),
      storage: makeStorage({ loadDiagram: async () => TWO_PAGES } as never).storage
    });
    renderLifecycle();
    await waitFor(() => expect(switched.length).toBeGreaterThan(0));
    expect(new Set(switched)).toEqual(new Set(['local']));
  });

  it('a deploy without server storage has no diagram URLs: back to /app', async () => {
    mockLocation = { pathname: '/d/abc', search: '' };
    appStorage = appStorageValue({ serverStorageAvailable: false, remoteStorageActive: false });
    renderLifecycle();
    await waitFor(() => expect(navigations.at(-1)).toEqual({ to: '/', replace: true }));
  });
});
