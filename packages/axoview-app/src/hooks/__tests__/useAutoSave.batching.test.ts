/**
 * `useAutoSave` with batched uploads (server storage, alone in the workspace):
 * every 2 s pause is a checkpoint in the browser, and the upload goes out once
 * per batch window with the latest checkpoint, or at once when it matters.
 */
import { renderHook, act } from '@testing-library/react';
import { useAutoSave, type AutoSaveBatching } from '../useAutoSave';
import type { StorageProvider } from '../../services/storage/types';
import type { DiagramData } from '../../diagramUtils';

const DEBOUNCE_MS = 2000;
const BATCH_MS = 30_000;

const MODEL = (title: string): DiagramData =>
  ({ title, icons: [], colors: [], items: [], views: [], fitToScreen: true }) as DiagramData;

function setup({ persisted = true, company = false } = {}) {
  const uploads: string[] = [];
  const storage = {
    saveDiagram: async (_id: string, model: unknown) => {
      uploads.push((model as DiagramData).title as string);
    }
  } as unknown as StorageProvider;
  const checkpoints: string[] = [];
  const uploaded: string[] = [];
  let rev = 0;
  const state = { persisted, company };
  const batch: AutoSaveBatching = {
    maxDelayMs: BATCH_MS,
    uploadNow: () => state.company,
    checkpoint: async (_id, model) => {
      checkpoints.push(model.title as string);
      rev += 1;
      return { rev: `r${rev}`, persisted: state.persisted };
    },
    onUploaded: (_id, r) => uploaded.push(r)
  };
  const hook = renderHook(() => useAutoSave({ storage, enabled: true, batch }));
  return { hook, uploads, checkpoints, uploaded, state };
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
