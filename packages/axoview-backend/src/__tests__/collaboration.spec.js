import { describe, it, expect } from '@jest/globals';
import * as Y from 'yjs';
import { seedModel, patchModel, readModel } from '@axoview/collaboration';
import { createCollaboration, createJournal } from '../collaboration.js';

const model = { title: 'Test', items: [{ id: 'a', name: 'A', icon: 'server' }, { id: 'b', name: 'B' }], views: [{ id: 'v', items: [] }], colors: [], icons: [] };
const clone = value => JSON.parse(JSON.stringify(value));
function replicas() {
  const a = seedModel(model, new Y.Doc()), b = new Y.Doc(); Y.applyUpdate(b, Y.encodeStateAsUpdate(a)); return [a, b];
}
function merge(a, b) { const ua = Y.encodeStateAsUpdate(a), ub = Y.encodeStateAsUpdate(b); Y.applyUpdate(a, ub); Y.applyUpdate(b, ua); }

describe('diagram CRDT', () => {
  it('retains a concurrent insertion when another author deletes all old entities', () => {
    const [a, b] = replicas(), left = clone(model), right = clone(model);
    left.items = []; right.items.push({ id: 'new', name: 'New' });
    patchModel(a, model, left); patchModel(b, model, right); merge(a, b);
    expect(readModel(a).items.map(item => item.id)).toEqual(['new']);
    expect(readModel(a)).toEqual(readModel(b));
  });
  it('merges concurrent character edits inside a label', () => {
    const [a, b] = replicas(), left = clone(model), right = clone(model);
    left.title = 'Our Test'; right.title = 'Test Diagram';
    patchModel(a, model, left); patchModel(b, model, right); merge(a, b);
    expect(readModel(a).title).toBe('Our Test Diagram');
    expect(readModel(a)).toEqual(readModel(b));
  });
  it('merges simultaneous changes to different properties of the same item', () => {
    const [a, b] = replicas(), left = clone(model), right = clone(model);
    left.items[0].name = 'Renamed'; right.items[0].icon = 'cloud';
    patchModel(a, model, left); patchModel(b, model, right); merge(a, b);
    expect(readModel(a)).toEqual(readModel(b));
    expect(readModel(a).items[0]).toEqual({ id: 'a', name: 'Renamed', icon: 'cloud' });
  });
  it('does not resurrect a remotely deleted item when a stale render changes a title', () => {
    const [a, b] = replicas(), deleted = clone(model), renamed = clone(model);
    deleted.items.splice(0, 1); patchModel(a, model, deleted);
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    renamed.title = 'New title'; patchModel(b, model, renamed); merge(a, b);
    expect(readModel(a).items.map(item => item.id)).toEqual(['b']);
    expect(readModel(a).title).toBe('New title');
  });
  it('deduplicates replay and merges concurrent insertions by stable identity', () => {
    const [a, b] = replicas(), left = clone(model), right = clone(model);
    left.items.push({ id: 'c', name: 'C' }); right.items.push({ id: 'd', name: 'D' });
    patchModel(a, model, left); patchModel(b, model, right); merge(a, b); merge(a, b);
    expect(readModel(a)).toEqual(readModel(b));
    expect(readModel(a).items.map(item => item.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('durable update boundary', () => {
  function fixture() {
    const objects = new Map([['diagrams/test', Buffer.from(JSON.stringify({ ...model, id: 'test' }))]]);
    const adapter = {
      get: async key => objects.get(key),
      put: async (key, bytes) => { objects.set(key, bytes); },
      putIfAbsent: async (key, bytes) => { if (objects.has(key)) return false; objects.set(key, bytes); return true; }
    };
    return { objects, target: { adapter, owner: 'alice', role: 'owner' } };
  }
  it('recovers acknowledged edits on a new API instance before a JSON snapshot', async () => {
    const { target, objects } = fixture(), journal = createJournal({}); const notices = [];
    const service = createCollaboration({ journal, notify: async (_target, change) => notices.push(change) });
    const initial = await service.state(target, 'test'), doc = new Y.Doc();
    Y.applyUpdate(doc, Buffer.from(initial.update, 'base64')); const vector = Y.encodeStateVector(doc);
    patchModel(doc, model, { ...model, title: 'Recovered' });
    const update = Buffer.from(Y.encodeStateAsUpdate(doc, vector)).toString('base64');
    await service.update(target, 'test', update, 'device-123');
    expect(JSON.parse(new TextDecoder().decode(objects.get('diagrams/test'))).title).toBe('Test');
    const restarted = createCollaboration({ journal: createJournal({}), notify: async () => {} });
    expect((await restarted.state(target, 'test')).model.title).toBe('Recovered');
    await restarted.snapshot(target, 'test');
    expect(JSON.parse(new TextDecoder().decode(objects.get('diagrams/test'))).title).toBe('Recovered');
    expect(notices[0].kind).toBe('collaboration');
  });
  it('does not announce success when journal persistence fails', async () => {
    const { target } = fixture(); let announced = false;
    const journal = { since: async () => [], append: async () => { throw Error('storage unavailable'); } };
    const service = createCollaboration({ journal, notify: async () => { announced = true; } });
    const state = await service.state(target, 'test');
    await expect(service.update(target, 'test', state.update, 'device-123')).rejects.toThrow('storage unavailable');
    expect(announced).toBe(false);
  });
});
