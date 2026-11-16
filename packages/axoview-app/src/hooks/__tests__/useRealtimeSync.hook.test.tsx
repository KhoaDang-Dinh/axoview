/**
 * useRealtimeSync wired to a fake stream: what the open tab does when a change
 * arrives (reload, keep local edits, follow a delete or rename), how reloads
 * queue, and how a hidden tab closes and catches up.
 */
import { act, renderHook } from '@testing-library/react';
import type { SyncChange } from '../../services/sync/realtimeSync';
import { useRealtimeSync, type SyncState, type UseRealtimeSyncOptions } from '../useRealtimeSync';

const streams: Array<{ onChange: (change: SyncChange) => void; closed: boolean }> = [];
jest.mock('../../services/sync/realtimeSync', () => ({
  connectRealtimeSync: (options: { onChange: (change: SyncChange) => void }) => {
    const stream = { onChange: options.onChange, closed: false };
    streams.push(stream);
    return { close: () => { stream.closed = true; } };
  }
}));

const live = () => streams.filter((s) => !s.closed);
const send = (change: Partial<SyncChange>) =>
  act(() => { live()[0].onChange({ seq: 1, kind: 'diagram', ...change } as SyncChange); });

function setVisibility(state: 'hidden' | 'visible') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  act(() => { document.dispatchEvent(new Event('visibilitychange')); });
}

function setup(state: Partial<SyncState> = {}, overrides: Partial<UseRealtimeSyncOptions> = {}) {
  const current: SyncState = { openDiagramId: 'd1', hasUnsavedWork: false, knownVersion: 3, ...state };
  const reloads: Array<() => void> = [];
  const options = {
    enabled: true,
    baseUrl: 'http://api',
    getState: () => current,
    // Each reload stays pending until the test finishes it.
    reloadOpenDiagram: jest.fn(() => new Promise<void>((resolve) => { reloads.push(resolve); })),
    refreshTree: jest.fn(),
    onOpenDeleted: jest.fn(),
    onOpenRenamed: jest.fn(),
    notify: jest.fn(),
    t: (_key: string, fallback: string) => fallback,
    ...overrides
  };
  const hook = renderHook((props: UseRealtimeSyncOptions) => useRealtimeSync(props), { initialProps: options });
  const finishReload = async () => { await act(async () => { reloads.shift()?.(); }); };
  return { options, current, hook, finishReload };
}

beforeEach(() => {
  streams.length = 0;
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
});

it('opens one stream when enabled, none when disabled, and closes it on unmount', () => {
  const off = setup({}, { enabled: false });
  expect(streams).toHaveLength(0);
  off.hook.unmount();

  const on = setup();
  expect(live()).toHaveLength(1);
  on.hook.unmount();
  expect(live()).toHaveLength(0);
});

it('a newer save of the open diagram reloads it; a version it already has does not', async () => {
  const { options, finishReload } = setup();
  send({ action: 'save', id: 'd1', version: 3 });
  expect(options.reloadOpenDiagram).not.toHaveBeenCalled();
  send({ action: 'save', id: 'd1', version: 4 });
  expect(options.reloadOpenDiagram).toHaveBeenCalledTimes(1);
  await finishReload();
});

it('reloads run one at a time: changes during a reload queue exactly one more', async () => {
  const { options, finishReload } = setup({ knownVersion: undefined });
  send({ action: 'save', id: 'd1' });
  send({ action: 'save', id: 'd1' });
  send({ action: 'save', id: 'd1' });
  expect(options.reloadOpenDiagram).toHaveBeenCalledTimes(1);
  await finishReload();
  expect(options.reloadOpenDiagram).toHaveBeenCalledTimes(2);
  await finishReload();
  expect(options.reloadOpenDiagram).toHaveBeenCalledTimes(2);
});

it('a failed reload does not stop the next change from reloading', async () => {
  const reload = jest.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
  const { options } = setup({ knownVersion: undefined }, { reloadOpenDiagram: reload });
  send({ action: 'save', id: 'd1' });
  await act(async () => { await Promise.resolve(); });
  send({ action: 'save', id: 'd1' });
  await act(async () => { await Promise.resolve(); });
  expect(options.reloadOpenDiagram).toHaveBeenCalledTimes(2);
});

it('with unsaved edits the tab keeps them and says so once per diagram', () => {
  const { options } = setup({ hasUnsavedWork: true });
  send({ action: 'save', id: 'd1', version: 4 });
  send({ action: 'save', id: 'd1', version: 5 });
  expect(options.reloadOpenDiagram).not.toHaveBeenCalled();
  expect(options.notify).toHaveBeenCalledTimes(1);
  expect(options.notify).toHaveBeenCalledWith('info', expect.stringContaining('another device'));
});

it('the "kept your edits" notice comes back after a clean reload', async () => {
  const { options, current, finishReload } = setup({ hasUnsavedWork: true });
  send({ action: 'save', id: 'd1', version: 4 });
  current.hasUnsavedWork = false;
  send({ action: 'save', id: 'd1', version: 5 });
  await finishReload();
  current.hasUnsavedWork = true;
  send({ action: 'save', id: 'd1', version: 6 });
  expect(options.notify).toHaveBeenCalledTimes(2);
});

it('the open diagram deleted elsewhere: closed, tree refreshed, user warned', () => {
  const { options } = setup();
  send({ action: 'delete', id: 'd1' });
  expect(options.onOpenDeleted).toHaveBeenCalledWith('d1');
  expect(options.refreshTree).toHaveBeenCalled();
  expect(options.notify).toHaveBeenCalledWith('warning', expect.stringContaining('deleted'));
  expect(options.reloadOpenDiagram).not.toHaveBeenCalled();
});

it('the open diagram renamed elsewhere: the new name is applied without a reload', () => {
  const { options } = setup();
  send({ action: 'update', id: 'd1', name: 'New name' });
  expect(options.onOpenRenamed).toHaveBeenCalledWith('d1', 'New name');
  expect(options.refreshTree).toHaveBeenCalled();
  expect(options.reloadOpenDiagram).not.toHaveBeenCalled();
});

it('other diagrams: content saves are ignored, structure changes refresh the tree', () => {
  const { options } = setup();
  send({ action: 'save', id: 'other', version: 9 });
  expect(options.refreshTree).not.toHaveBeenCalled();
  send({ action: 'create', id: 'new' });
  send({ kind: 'folder', action: 'move', id: 'f1' });
  expect(options.refreshTree).toHaveBeenCalledTimes(2);
  expect(options.reloadOpenDiagram).not.toHaveBeenCalled();
});

describe('live notices of AI agents\' work', () => {
  it('a new proposal named by its agent: one notice, and the prompt is told not to pop up again', () => {
    const onAgentProposal = jest.fn();
    setup({}, { onAgentProposal });
    const heard: unknown[] = [];
    const listener = (e: Event) => heard.push((e as CustomEvent).detail);
    window.addEventListener('axoview-proposals-changed', listener);
    send({ kind: 'proposal', action: 'create', id: 'd9', agent: 'Claude Code', steps: 3, diagramName: 'Network' });
    // A decision, or a proposal with no agent named (an older server): the list refreshes, no notice.
    send({ kind: 'proposal', action: 'resolve', id: 'd9', status: 'approved' });
    send({ kind: 'proposal', action: 'create', id: 'd9' });
    window.removeEventListener('axoview-proposals-changed', listener);
    expect(onAgentProposal).toHaveBeenCalledTimes(1);
    expect(onAgentProposal).toHaveBeenCalledWith(expect.objectContaining({ agent: 'Claude Code', steps: 3, id: 'd9' }));
    expect(heard).toEqual([
      { id: 'd9', announced: true, action: 'create' },
      { id: 'd9', announced: false, action: 'resolve' },
      { id: 'd9', announced: false, action: 'create' }
    ]);
  });

  it('an agent\'s change saved elsewhere: a notice, with the diagram open (after its reload) or not', async () => {
    const onAgentChange = jest.fn();
    const { options, finishReload } = setup({}, { onAgentChange });
    send({ action: 'save', id: 'd1', version: 4, agent: 'Claude Code' });
    expect(options.reloadOpenDiagram).toHaveBeenCalledTimes(1);
    await finishReload();
    send({ action: 'save', id: 'd2', version: 9, agent: 'Nova', diagramName: 'Other' });
    expect(onAgentChange.mock.calls).toEqual([
      [expect.objectContaining({ id: 'd1', agent: 'Claude Code' }), true],
      [expect.objectContaining({ id: 'd2', agent: 'Nova', diagramName: 'Other' }), false]
    ]);
  });

  it('no notice for a change this tab already holds, or a save no agent made', () => {
    const onAgentChange = jest.fn();
    setup({}, { onAgentChange, alreadyHave: (c) => c.version === 7 });
    send({ action: 'save', id: 'd1', version: 3, agent: 'Claude Code' });
    send({ action: 'save', id: 'd1', version: 7, agent: 'Claude Code' });
    send({ action: 'save', id: 'd2', version: 9 });
    send({ action: 'update', id: 'd2', name: 'Renamed', agent: 'Nova' });
    expect(onAgentChange).not.toHaveBeenCalled();
  });
});

it('the latest options are used without reopening the stream', () => {
  const { options, hook } = setup();
  const refreshTree = jest.fn();
  hook.rerender({ ...options, refreshTree });
  send({ kind: 'tree', action: 'save' });
  expect(refreshTree).toHaveBeenCalledTimes(1);
  expect(options.refreshTree).not.toHaveBeenCalled();
  expect(streams).toHaveLength(1);
});

describe('a hidden tab', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('keeps its stream for a minute, then closes it', () => {
    setup();
    setVisibility('hidden');
    act(() => { jest.advanceTimersByTime(59_000); });
    expect(live()).toHaveLength(1);
    act(() => { jest.advanceTimersByTime(1_000); });
    expect(live()).toHaveLength(0);
  });

  it('shown again within the minute: same stream, no catch-up', () => {
    const { options } = setup();
    setVisibility('hidden');
    act(() => { jest.advanceTimersByTime(30_000); });
    setVisibility('visible');
    act(() => { jest.advanceTimersByTime(60_000); });
    expect(streams).toHaveLength(1);
    expect(live()).toHaveLength(1);
    expect(options.reloadOpenDiagram).not.toHaveBeenCalled();
  });

  it('shown again after closing: catches up (tree and open diagram) and reopens', () => {
    const { options } = setup();
    setVisibility('hidden');
    act(() => { jest.advanceTimersByTime(60_000); });
    setVisibility('visible');
    expect(options.refreshTree).toHaveBeenCalledTimes(1);
    expect(options.reloadOpenDiagram).toHaveBeenCalledTimes(1);
    expect(live()).toHaveLength(1);
    expect(streams).toHaveLength(2);
  });

  it('shown again after closing, with unsaved edits: the tree refreshes, the edits stay', () => {
    const { options } = setup({ hasUnsavedWork: true });
    setVisibility('hidden');
    act(() => { jest.advanceTimersByTime(60_000); });
    setVisibility('visible');
    expect(options.refreshTree).toHaveBeenCalledTimes(1);
    expect(options.reloadOpenDiagram).not.toHaveBeenCalled();
  });
});
