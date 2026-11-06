import { createAwsWorkspaceAdapter } from '../../adapters/aws.js';
import { makeAwsDoubles } from '../helpers/awsDoubles.js';

const asBytes = (value) => new TextEncoder().encode(JSON.stringify(value));
const asJson = (value) => JSON.parse(new TextDecoder().decode(value));

describe('AWS workspace storage adapter', () => {
  test('keeps diagram metadata and bodies isolated by workspace', async () => {
    const doubles = makeAwsDoubles();
    const alice = createAwsWorkspaceAdapter({ workspaceId: 'alice', bucketName: 'data', tableName: 'app', ...doubles });
    const bob = createAwsWorkspaceAdapter({ workspaceId: 'bob', bucketName: 'data', tableName: 'app', ...doubles });

    await alice.put('diagrams/d1', asBytes({ id: 'd1', title: 'Alice diagram', lastModified: 'now' }));
    expect(asJson(await alice.get('diagrams/d1')).title).toBe('Alice diagram');
    expect(await bob.get('diagrams/d1')).toBeNull();
    expect(await bob.listDiagramMeta()).toEqual([]);
    expect(await alice.listDiagramMeta()).toEqual([
      { id: 'd1', name: 'Alice diagram', lastModified: 'now', folderId: null, deletedAt: null, version: 1 }
    ]);
    expect([...doubles.objects.keys()][0]).toMatch(/^workspaces\/alice\/diagrams\/d1\//);
  });

  test('conditional metadata writes reject an old version after a competing save', async () => {
    const doubles = makeAwsDoubles();
    const adapter = createAwsWorkspaceAdapter({ workspaceId: 'alice', bucketName: 'data', tableName: 'app', ...doubles });
    await adapter.put('diagrams/d1', asBytes({ id: 'd1', title: 'initial' }));
    const staleVersion = await adapter.getDiagramVersion('d1');
    await adapter.put('diagrams/d1', asBytes({ id: 'd1', title: 'new save' }), { expectedVersion: staleVersion });
    await expect(adapter.put(
      'diagrams/d1',
      asBytes({ id: 'd1', title: 'stale save' }),
      { expectedVersion: staleVersion }
    )).rejects.toMatchObject({ status: 409, body: { code: 'VERSION_CONFLICT' } });
    expect(asJson(await adapter.get('diagrams/d1')).title).toBe('new save');
  });

  test('public snapshots resolve through the global share index but remain scoped to their owner', async () => {
    const doubles = makeAwsDoubles();
    const alice = createAwsWorkspaceAdapter({ workspaceId: 'alice', bucketName: 'data', tableName: 'app', ...doubles });
    const bob = createAwsWorkspaceAdapter({ workspaceId: 'bob', bucketName: 'data', tableName: 'app', ...doubles });
    await alice.put('public/abcdefghijklmnopqrstu', asBytes({ title: 'shared' }));
    expect(asJson(await bob.get('public/abcdefghijklmnopqrstu'))).toEqual({ title: 'shared' });
    await bob.delete('public/abcdefghijklmnopqrstu');
    expect(asJson(await alice.get('public/abcdefghijklmnopqrstu'))).toEqual({ title: 'shared' });
  });
});
