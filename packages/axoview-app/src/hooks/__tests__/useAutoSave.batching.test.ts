/**
 * `useAutoSave` with batched uploads (server storage, alone in the workspace):
 * every 1 s pause is a checkpoint in the browser, and the upload goes out once
 * per batch window with the latest checkpoint, or at once when it matters
 * (another browser present, or a diagram other people have).
 */
import { renderHook, act } from '@testing-library/react';
import { DEBOUNCE_MS, useAutoSave, type AutoSaveBatching } from '../useAutoSave';
import type { StorageProvider } from '../../services/storage/types';
import type { DiagramData } from '../../diagramUtils';

const BATCH_MS = 30_000;

const MODEL = (title: string): DiagramData =>
  ({ title, icons: [], colors: [], items: [], views: [], fitToScreen: true }) as DiagramData;

function setup({ persisted = true, company = false, shared = [] as string[] } = {}) {
  const uploads: string[] = [];
  const storage = {
    saveDiagram: async (_id: string, model: unknown) => {
      uploads.push((model as DiagramData).title as string);
    }
  } as unknown as StorageProvider;
  const checkpoints: string[] = [];
  const uploaded: string[] = [];
  let rev = 0;
  const state = { persisted, company, shared: new Set(shared) };
  const askedAbout: string[] = [];
  const batch: AutoSaveBatching = {
    maxDelayMs: BATCH_MS,
    uploadNow: (id) => {
      askedAbout.push(id);
      return state.company || state.shared.has(id);
    },
    checkpoint: async (_id, model) => {
      checkpoints.push(model.title as string);
      rev += 1;
      return { rev: `r${rev}`, persisted: state.persisted };
    },
    onUploaded: (_id, r) => uploaded.push(r)
  };
  const hook = renderHook(() => useAutoSave({ storage, enabled: true, batch }));
  return { hook, uploads, checkpoints, uploaded, state, askedAbout };
}

/** Let the debounce fire and the async checkpoint settle. */
async function pause(ms = DEBOUNCE_MS) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

test('each pause is a checkpoint; one upload per batch window carries the latest', async () => {
  const { hook, uploads, checkpoints, uploaded } = setup();
  for (const title of ['a', 'b', 'c']) {
    act(() => hook.result.current.scheduleSave('d1', MODEL(title)));
    await pause();
    expect(hook.result.current.saveStatus).toBe('local');
  }
  expect(checkpoints).toEqual(['a', 'b', 'c']);
  expect(uploads).toEqual([]);

  // The window opened at the first checkpoint: 30 s after it, one upload.
  await pause(BATCH_MS - 2 * DEBOUNCE_MS);
  expect(uploads).toEqual(['c']);
  expect(uploaded).toEqual(['r3']);
  expect(hook.result.current.saveStatus).toBe('idle');
});

test('with another browser present every checkpoint uploads at once', async () => {
  const { hook, uploads, checkpoints } = setup({ company: true });
  act(() => hook.result.current.scheduleSave('d1', MODEL('a')));
  await pause();
  act(() => hook.result.current.scheduleSave('d1', MODEL('b')));
  await pause();
  expect(checkpoints).toEqual(['a', 'b']);
  expect(uploads).toEqual(['a', 'b']);
});

test('a checkpoint that could not be persisted uploads at once (a crash would lose it)', async () => {
  const { hook, uploads } = setup({ persisted: false });
  act(() => hook.result.current.scheduleSave('d1', MODEL('a')));
  await pause();
  expect(uploads).toEqual(['a']);
});

test('saveNow uploads the queued checkpoint at once and disarms the batch timer', async () => {
  const { hook, uploads, uploaded } = setup();
  act(() => hook.result.current.scheduleSave('d1', MODEL('a')));
  await pause();
  let outcome: string | undefined;
  await act(async () => { outcome = await hook.result.current.saveNow(); });
  expect(outcome).toBe('saved');
  expect(uploads).toEqual(['a']);
  expect(uploaded).toEqual(['r1']);
  await pause(BATCH_MS);
  expect(uploads).toEqual(['a']);
});

test('a flush before the debounce uploads newer content and settles the last checkpoint with it', async () => {
  const { hook, uploads, uploaded } = setup();
  act(() => hook.result.current.scheduleSave('d1', MODEL('a')));
  await pause();
  act(() => hook.result.current.scheduleSave('d1', MODEL('b')));
  await act(async () => { await hook.result.current.saveNow(); });
  expect(uploads).toEqual(['b']);
  // 'b' includes checkpoint r1's content: its draft is done too.
  expect(uploaded).toEqual(['r1']);
});

test('the unload warning counts only work not yet saved in the browser', async () => {
  const { hook, state } = setup();
  act(() => hook.result.current.scheduleSave('d1', MODEL('a')));
  // Inside the debounce: not even a checkpoint yet.
  expect(hook.result.current.hasUnpersistedWork()).toBe(true);
  await pause();
  // Persisted checkpoint, upload queued: unsaved on the server, safe locally.
  expect(hook.result.current.hasUnsavedWork()).toBe(true);
  expect(hook.result.current.hasUnpersistedWork()).toBe(false);

  state.persisted = false;
  act(() => hook.result.current.scheduleSave('d1', MODEL('b')));
  expect(hook.result.current.hasUnpersistedWork()).toBe(true);
});

test('dropQueued: another tab took over the content, so the queued upload is dropped', async () => {
  const { hook, uploads } = setup();
  act(() => hook.result.current.scheduleSave('d1', MODEL('a')));
  await pause();
  act(() => hook.result.current.dropQueued('d1'));
  expect(hook.result.current.hasUnsavedWork()).toBe(false);
  await pause(BATCH_MS);
  expect(uploads).toEqual([]);
});

test('dropQueued leaves an edit inside its debounce alone', async () => {
  const { hook, uploads } = setup({ company: true });
  act(() => hook.result.current.scheduleSave('d1', MODEL('a')));
  act(() => hook.result.current.dropQueued('d1'));
  await pause();
  expect(uploads).toEqual(['a']);
});

test('without batching, the 2 s autosave uploads directly as before', async () => {
  const uploads: string[] = [];
  const storage = {
    saveDiagram: async (_id: string, model: unknown) => { uploads.push((model as DiagramData).title as string); }
  } as unknown as StorageProvider;
  const hook = renderHook(() => useAutoSave({ storage, enabled: true }));
  act(() => hook.result.current.scheduleSave('d1', MODEL('a')));
  await pause();
  expect(uploads).toEqual(['a']);
});

test('a save starts 2.5 s after the last edit', async () => {
  expect(DEBOUNCE_MS).toBe(2500);
  const { hook, checkpoints } = setup();
  act(() => hook.result.current.scheduleSave('d1', MODEL('a')));
  await pause(2499);
  expect(checkpoints).toEqual([]);
  await pause(1);
  expect(checkpoints).toEqual(['a']);
});

test('a diagram other people have uploads at once; the others still batch', async () => {
  const { hook, uploads, askedAbout } = setup({ shared: ['shared-1'] });
  act(() => hook.result.current.scheduleSave('shared-1', MODEL('theirs-too')));
  await pause();
  expect(uploads).toEqual(['theirs-too']);
  expect(askedAbout).toEqual(['shared-1']);

  act(() => hook.result.current.scheduleSave('mine', MODEL('only-mine')));
  await pause();
  expect(uploads).toEqual(['theirs-too']);
  expect(hook.result.current.saveStatus).toBe('local');
});
