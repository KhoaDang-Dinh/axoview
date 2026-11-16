/**
 * Opening a diagram draws it once, on a page that keeps its id.
 *
 * Regression (dev, 2026-11-09: "page id keeps changing and blinks"):
 *  - A diagram stored without pages (a blank one created and never edited)
 *    got a new random page id from the editor on every load, so ?page=
 *    changed on each open, refresh and sync reload, and the canvas switched
 *    page under the user.
 *  - A draft of the diagram in this browser was restored AFTER the server copy
 *    had been drawn: the server copy, then the draft over it, a moment apart.
 */
import { act, waitFor } from '@testing-library/react';

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
// One array for every render: a new one re-runs the provider's icon reload,
// which would count as a draw here.
const mockNoIcons: unknown[] = [];
jest.mock('../../services/iconPackManager', () => ({
  useIconPackManager: () => ({
    loadedIcons: mockNoIcons, getLoadedIcons: () => [], loadPacksForDiagram: async () => {},
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
// IndexedDB is not in jsdom: a Map stands in for it (services/storage/draftDb.ts).
const disk = new Map<string, unknown>();
jest.mock('../../services/storage/draftDb', () => ({
  draftDbPut: async (key: string, value: unknown) => { disk.set(key, value); return true; },
  draftDbGet: async (key: string) => disk.get(key) ?? null,
  draftDbDelete: async (key: string) => { disk.delete(key); },
  draftDbDeletePrefix: async (prefix: string) => {
    Array.from(disk.keys()).filter((key) => key.startsWith(prefix)).forEach((key) => disk.delete(key));
  }
}));

import { renderLifecycle, appStorageValue, makeStorage } from '../../testUtils/lifecycleHarness';
import { notificationStore } from '../../stores/notificationStore';
import { useDraftStore } from '../../stores/draftStore';
import { firstPageId } from '../DiagramLifecycleProvider';

type Page = { id: string; name: string; items: unknown[] };
type Drawn = { title?: string; views: Page[]; items: unknown[] };

const page = (id: string, items: unknown[] = []): Page =>
  ({ id, name: id, items, connectors: [], rectangles: [], textBoxes: [] } as Page);
const NO_PAGES = { title: 'Blank', items: [], views: [] };
const COLORS = [{ id: 'c1', value: '#0066cc' }];
const SERVER_COPY = { title: 'Saved', colors: COLORS, items: [], views: [page('p1')] };
const EDITED = { title: 'Saved', icons: [], colors: COLORS, items: [], views: [page('p1', [{ id: 'n1', tile: { x: 1, y: 1 } }])] };

let toasts: Array<{ severity: string; message: string; action?: unknown }>;
beforeEach(() => {
  mockLocation = { pathname: '/', search: '' };
  navigations.length = 0;
  localStorage.clear();
  disk.clear();
  useDraftStore.setState({ drafts: {} });
  toasts = [];
  jest.spyOn(notificationStore, 'push').mockImplementation((n) => {
    toasts.push(n as { severity: string; message: string });
    return undefined as never;
  });
});
afterEach(() => jest.restoreAllMocks());

/** A stand-in editor: records every draw, and reports the page it shows. */
function mountEditor(h: ReturnType<typeof renderLifecycle>) {
  const draws: Drawn[] = [];
  let active: string | undefined;
  (h.ctx().axoviewRef as { current: unknown }).current = {
    load: (data: Drawn, opts?: { view?: string }) => {
      draws.push(data);
      active = opts?.view && data.views.some((v) => v.id === opts.view) ? opts.view : data.views[0]?.id;
    },
    getActiveViewId: () => active
  };
  return draws;
}

const server = (storage: ReturnType<typeof makeStorage>['storage']) =>
  appStorageValue({ serverStorageAvailable: true, remoteStorageActive: true, storage });

describe('a diagram stored without pages', () => {
  it('opens on the same page id every time, and the URL keeps it', async () => {
    const double = makeStorage({ loadDiagram: async () => NO_PAGES } as never);
    appStorage = server(double.storage);
    const h = renderLifecycle();
    const draws = mountEditor(h);
    await act(async () => { await h.ctx().openDiagramById('abc', 'Blank'); });
    await act(async () => { await h.ctx().openDiagramById('abc', 'Blank'); });
    expect(draws.map((d) => d.views.map((v) => v.id))).toEqual([[firstPageId('abc')], [firstPageId('abc')]]);
    expect(navigations.map((n) => n.to)).toEqual([`/d/abc?page=${firstPageId('abc')}`]);
  });

  it('a refresh on its page lands on that page', async () => {
    mockLocation = { pathname: '/d/abc', search: `?page=${firstPageId('abc')}` };
    appStorage = server(makeStorage({ loadDiagram: async () => NO_PAGES } as never).storage);
    const h = renderLifecycle();
    await waitFor(() => expect(h.ctx().currentDiagram?.id).toBe('abc'));
    expect((h.ctx().frozenInitialDataRef.current as { view?: string } | null)?.view).toBe(firstPageId('abc'));
  });

  it('pages it already has are kept as they are', async () => {
    appStorage = server(makeStorage({ loadDiagram: async () => SERVER_COPY } as never).storage);
    const h = renderLifecycle();
    const draws = mountEditor(h);
    await act(async () => { await h.ctx().openDiagramById('abc', 'Saved'); });
    expect(draws[0].views.map((v) => v.id)).toEqual(['p1']);
  });
});

describe('a draft in this browser', () => {
  const withDraft = async (baseStamp: string, model: unknown = EDITED) => {
    disk.set('draft:workspace:abc', { userKey: 'workspace', id: 'abc', model, baseStamp, rev: 'r1', savedAt: 1 });
    const double = makeStorage({
      loadDiagram: async () => SERVER_COPY,
      serverStamp: () => 'v3'
    } as never);
    appStorage = server(double.storage);
    const h = renderLifecycle();
    const draws = mountEditor(h);
    await act(async () => { await h.ctx().openDiagramById('abc', 'Saved'); });
    return { double, draws };
  };

  it('made from the version the server has: drawn once, as the draft, then uploaded', async () => {
    const { double, draws } = await withDraft('v3');
    expect(draws).toHaveLength(1);
    expect(draws[0].views[0].items).toHaveLength(1);
    await waitFor(() => expect(double.saveCalls).toEqual([{ id: 'abc', title: 'Saved' }]));
    await waitFor(() => expect(disk.has('draft:workspace:abc')).toBe(false));
    expect(toasts).toEqual([expect.objectContaining({ severity: 'info', message: expect.stringContaining('Restored edits') })]);
  });

  it('the server moved on since: the server copy is drawn, once, and the draft is offered', async () => {
    const { double, draws } = await withDraft('v2');
    expect(draws).toHaveLength(1);
    expect(draws[0].views[0].items).toHaveLength(0);
    expect(double.saveCalls).toEqual([]);
    expect(toasts).toEqual([expect.objectContaining({ severity: 'warning', action: expect.anything() })]);
    expect(disk.has('draft:workspace:abc')).toBe(true);
  });

  it('already on the server: dropped quietly', async () => {
    const { double, draws } = await withDraft('v3', { ...SERVER_COPY, icons: [] });
    expect(draws).toHaveLength(1);
    expect(double.saveCalls).toEqual([]);
    expect(toasts).toEqual([]);
    expect(disk.has('draft:workspace:abc')).toBe(false);
  });

  it('holding a page the server never got: the URL\'s ?page= opens on it, in one draw', async () => {
    mockLocation = { pathname: '/d/abc', search: '?page=p2' };
    const withNewPage = { ...EDITED, views: [page('p1'), page('p2')] };
    disk.set('draft:workspace:abc', { userKey: 'workspace', id: 'abc', model: withNewPage, baseStamp: 'v3', rev: 'r1', savedAt: 1 });
    const double = makeStorage({ loadDiagram: async () => SERVER_COPY, serverStamp: () => 'v3' } as never);
    appStorage = server(double.storage);
    const h = renderLifecycle();
    const draws = mountEditor(h);
    let active: string | undefined;
    const editor = h.ctx().axoviewRef as unknown as { current: { load: (d: Drawn, o?: { view?: string }) => void } };
    const load = editor.current.load;
    editor.current.load = (d, o) => { load(d, o); active = o?.view; };
    await waitFor(() => expect(h.ctx().currentDiagram?.id).toBe('abc'));
    await waitFor(() => expect(double.saveCalls).toHaveLength(1));
    expect(draws).toHaveLength(1);
    expect(draws[0].views.map((v) => v.id)).toEqual(['p1', 'p2']);
    expect(active).toBe('p2');
    expect(navigations.filter((n) => !n.to.endsWith('?page=p2'))).toEqual([]);
  });
});
