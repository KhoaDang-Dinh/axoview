import { createWorkspaceAdapter } from '../../adapters/workspace.js';
import { createMemoryAdapter, decodeJson, makeCtx } from '../helpers/memoryAdapter.js';
import { createDiagram, getDiagram, listDiagrams, shareDiagram, getPublicSnapshot } from '../../routes.js';

const DIAGRAM = { title: 'Tenant diagram', items: [], views: [], icons: [], colors: [] };

describe('workspace storage scope', () => {
  test('two verified workspace ids cannot list or read each other’s diagrams', async () => {
    const base = createMemoryAdapter();
    const alice = createWorkspaceAdapter(base, 'alice-sub');
    const bob = createWorkspaceAdapter(base, 'bob-sub');

    const created = await createDiagram(alice, makeCtx({ body: DIAGRAM }));
    expect((await listDiagrams(alice, makeCtx())).body).toHaveLength(1);
    expect((await listDiagrams(bob, makeCtx())).body).toEqual([]);
    await expect(getDiagram(bob, makeCtx({ params: { id: created.body.id } })))
      .rejects.toMatchObject({ status: 404 });
    expect(decodeJson(base, `workspaces/alice-sub/diagrams/${created.body.id}`)).toMatchObject({
      title: 'Tenant diagram'
    });
  });

  test('public share is readable without auth and does not reveal workspace id', async () => {
    const base = createMemoryAdapter();
    const alice = createWorkspaceAdapter(base, 'alice-sub');
    const created = await createDiagram(alice, makeCtx({ body: DIAGRAM }));
    const shared = await shareDiagram(alice, makeCtx({ params: { id: created.body.id } }));
    const stored = decodeJson(base, `public/${shared.body.uuid}`);
    expect(stored.sourceWorkspaceId).toBe('alice-sub');

    const publicResult = await getPublicSnapshot(base, makeCtx({ params: { uuid: shared.body.uuid } }));
    expect(publicResult.body.title).toBe('Tenant diagram');
    expect(publicResult.body.sourceWorkspaceId).toBeUndefined();
  });

  test('rejects workspace ids that could escape the storage prefix', () => {
    expect(() => createWorkspaceAdapter(createMemoryAdapter(), '../bob')).toThrow('Invalid trusted workspace id');
  });
});
