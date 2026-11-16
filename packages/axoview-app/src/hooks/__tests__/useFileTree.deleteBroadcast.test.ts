/**
 * Moving a diagram to the trash, or deleting it for good, tells the other tabs
 * of this browser (tabChannel), which close it if it is open there. A delete
 * that fails tells no one.
 */
import { act, renderHook, waitFor } from '@testing-library/react';

const posted: unknown[] = [];
jest.mock('../../services/sync/tabChannel', () => ({
  postToTabs: (message: unknown) => { posted.push(message); },
  onTabMessage: () => () => {}
}));

import { useFileTree } from '../useFileTree';
import type { StorageProvider } from '../../services/storage/types';

function storage(deleteDiagram: (id: string, soft: boolean) => Promise<void>): StorageProvider {
  return {
    listDiagrams: async () => [],
    listFolders: async () => [],
    getTreeManifest: async () => null,
    deleteDiagram
  } as unknown as StorageProvider;
}

beforeEach(() => { posted.length = 0; });

it('trash and permanent delete both tell the other tabs', async () => {
  const deleted: Array<[string, boolean]> = [];
  const s = storage(async (id, soft) => { deleted.push([id, soft]); });
  const { result } = renderHook(() => useFileTree(s, 0));
  await waitFor(() => expect(result.current).toBeTruthy());
  await act(async () => { await result.current.softDeleteDiagram('d1'); });
  await act(async () => { await result.current.hardDeleteDiagram('d2'); });
  expect(deleted).toEqual([['d1', true], ['d2', false]]);
  expect(posted).toEqual([{ type: 'diagram-deleted', id: 'd1' }, { type: 'diagram-deleted', id: 'd2' }]);
});

it('a delete that fails tells no one', async () => {
  const s = storage(async () => { throw new Error('offline'); });
  const { result } = renderHook(() => useFileTree(s, 0));
  await waitFor(() => expect(result.current).toBeTruthy());
  await act(async () => {
    await expect(result.current.softDeleteDiagram('d1')).rejects.toThrow('offline');
  });
  expect(posted).toEqual([]);
});
