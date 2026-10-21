import { planSyncReaction, type SyncState } from '../useRealtimeSync';
import type { SyncChange } from '../../services/sync/realtimeSync';

const idle: SyncState = { openDiagramId: 'd1', hasUnsavedWork: false, knownVersion: 3 };
const editing: SyncState = { ...idle, hasUnsavedWork: true };
const change = (c: Partial<SyncChange>): SyncChange => ({ seq: 1, kind: 'diagram', ...c }) as SyncChange;

describe('planSyncReaction', () => {
  it('reloads the open diagram when another device saved a newer version', () => {
    expect(planSyncReaction(change({ action: 'save', id: 'd1', version: 4 }), idle))
      .toEqual({ type: 'reloadOpen', refreshTree: false });
  });

  it('ignores a version this tab already has', () => {
    expect(planSyncReaction(change({ action: 'save', id: 'd1', version: 3 }), idle))
      .toEqual({ type: 'ignore' });
  });

  it('reloads when the backend does not version diagrams (self-host fs)', () => {
    expect(planSyncReaction(change({ action: 'save', id: 'd1' }), { ...idle, knownVersion: undefined }))
      .toEqual({ type: 'reloadOpen', refreshTree: false });
  });

  it('keeps local edits when this tab has unsaved work (latest save wins)', () => {
    expect(planSyncReaction(change({ action: 'save', id: 'd1', version: 4 }), editing))
      .toEqual({ type: 'keepLocal' });
  });

  it('handles the open diagram deleted or trashed elsewhere', () => {
    expect(planSyncReaction(change({ action: 'delete', id: 'd1' }), idle)).toEqual({ type: 'openDeleted' });
    expect(planSyncReaction(change({ action: 'update', id: 'd1', deleted: true }), idle))
      .toEqual({ type: 'openDeleted' });
  });

  it('renames the open diagram', () => {
    expect(planSyncReaction(change({ action: 'update', id: 'd1', name: 'New' }), idle))
      .toEqual({ type: 'openRenamed', name: 'New' });
  });

  it('refreshes the tree for other diagrams, folders and the layout, but not for content saves', () => {
    expect(planSyncReaction(change({ action: 'save', id: 'other' }), idle)).toEqual({ type: 'ignore' });
    expect(planSyncReaction(change({ action: 'create', id: 'other' }), idle)).toEqual({ type: 'refreshTree' });
    expect(planSyncReaction(change({ kind: 'folder', action: 'move', id: 'f1' }), idle))
      .toEqual({ type: 'refreshTree' });
    expect(planSyncReaction(change({ kind: 'tree', action: 'save' }), idle)).toEqual({ type: 'refreshTree' });
  });

  it('resync: refresh the tree, and reload the open diagram only without local edits', () => {
    expect(planSyncReaction(change({ kind: 'resync' }), idle)).toEqual({ type: 'reloadOpen', refreshTree: true });
    expect(planSyncReaction(change({ kind: 'resync' }), editing)).toEqual({ type: 'refreshTree' });
    expect(planSyncReaction(change({ kind: 'resync' }), { ...idle, openDiagramId: null }))
      .toEqual({ type: 'refreshTree' });
  });
});
