import { useDraftStore, wipeAllDrafts } from '../draftStore';
import type { DiagramData } from '../../diagramUtils';

// IndexedDB is not in jsdom: a Map stands in for it (services/storage/draftDb.ts).
const disk = new Map<string, unknown>();
let diskWorks = true;
jest.mock('../../services/storage/draftDb', () => ({
  draftDbPut: async (key: string, value: unknown) => {
    if (!diskWorks) return false;
    disk.set(key, value);
    return true;
  },
  draftDbGet: async (key: string) => disk.get(key) ?? null,
  draftDbDelete: async (key: string) => { disk.delete(key); },
  draftDbDeletePrefix: async (prefix: string) => {
    Array.from(disk.keys()).filter((key) => key.startsWith(prefix)).forEach((key) => disk.delete(key));
  }
}));

const model = (title: string) => ({ title, icons: [], colors: [], items: [], views: [] }) as unknown as DiagramData;

beforeEach(() => {
  disk.clear();
  diskWorks = true;
  useDraftStore.setState({ drafts: {} });
});

test('a checkpoint is kept in memory and on disk, and says whether it persisted', async () => {
  const a = await useDraftStore.getState().checkpoint({ userKey: 'u1', id: 'd1', model: model('A'), baseVersion: 3 });
  expect(a.persisted).toBe(true);
  expect(disk.get('draft:u1:d1')).toEqual(expect.objectContaining({ rev: a.rev, baseVersion: 3 }));
  diskWorks = false;
  const b = await useDraftStore.getState().checkpoint({ userKey: 'u1', id: 'd1', model: model('B') });
  expect(b.persisted).toBe(false);
});

test('an upload clears its own checkpoint, not a newer one from another tab', async () => {
  const mine = await useDraftStore.getState().checkpoint({ userKey: 'u1', id: 'd1', model: model('A') });
  // Another tab of this browser wrote a newer checkpoint to disk meanwhile.
  disk.set('draft:u1:d1', { userKey: 'u1', id: 'd1', model: model('B'), rev: 'theirs', savedAt: 1 });
  await useDraftStore.getState().uploaded('u1', 'd1', mine.rev);
  expect(useDraftStore.getState().drafts['draft:u1:d1']).toBeUndefined();
  expect((disk.get('draft:u1:d1') as { rev: string }).rev).toBe('theirs');

  // And an upload of an older checkpoint leaves a newer one alone.
  const older = await useDraftStore.getState().checkpoint({ userKey: 'u1', id: 'd2', model: model('1') });
  const newer = await useDraftStore.getState().checkpoint({ userKey: 'u1', id: 'd2', model: model('2') });
  await useDraftStore.getState().uploaded('u1', 'd2', older.rev);
  expect(useDraftStore.getState().drafts['draft:u1:d2']?.rev).toBe(newer.rev);
  expect(disk.has('draft:u1:d2')).toBe(true);
});

test('find reads the disk first: it is shared by every tab', async () => {
  disk.set('draft:u1:d9', { userKey: 'u1', id: 'd9', model: model('X'), rev: 'from-another-tab', savedAt: 1 });
  expect((await useDraftStore.getState().find('u1', 'd9'))?.rev).toBe('from-another-tab');
  expect(await useDraftStore.getState().find('u2', 'd9')).toBeNull();
});

test('drafts belong to one user; sign-out wipes them', async () => {
  await useDraftStore.getState().checkpoint({ userKey: 'u1', id: 'd1', model: model('A') });
  await useDraftStore.getState().checkpoint({ userKey: 'u2', id: 'd1', model: model('B') });
  await useDraftStore.getState().wipeUser('u1');
  expect(Array.from(disk.keys())).toEqual(['draft:u2:d1']);
  expect(Object.keys(useDraftStore.getState().drafts)).toEqual(['draft:u2:d1']);
  await wipeAllDrafts();
  expect(disk.size).toBe(0);
  expect(useDraftStore.getState().drafts).toEqual({});
});
