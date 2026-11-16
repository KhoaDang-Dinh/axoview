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

describe('AWS adapter: create only if absent', () => {
  test('sends a conditional S3 write, and refuses diagram and public keys', async () => {
    const doubles = makeAwsDoubles();
    const adapter = createAwsWorkspaceAdapter({ workspaceId: 'alice', bucketName: 'data', tableName: 'app', ...doubles });
    expect(await adapter.putIfAbsent('oauth/claims/abc', asBytes({ a: 1 }))).toBe(true);
    expect(await adapter.putIfAbsent('oauth/claims/abc', asBytes({ a: 2 }))).toBe(false);
    expect(asJson(await adapter.get('oauth/claims/abc'))).toEqual({ a: 1 });
    expect([...doubles.objects.keys()]).toEqual(['workspaces/alice/objects/oauth/claims/abc.json']);
    await expect(adapter.putIfAbsent('diagrams/d1', asBytes({}))).rejects.toThrow(/generic objects/);
    await expect(adapter.putIfAbsent('public/abcdefghijklmnopqrstu', asBytes({}))).rejects.toThrow(/generic objects/);
  });

  test('retries S3\'s 409 "conflicting operation" and passes other failures on', async () => {
    const doubles = makeAwsDoubles();
    const real = doubles.s3Client.send.bind(doubles.s3Client);
    let conflicts = 2;
    doubles.s3Client.send = async (command) => {
      if (command.input.IfNoneMatch === '*' && conflicts-- > 0) {
        throw Object.assign(new Error('conflict'), { name: 'ConditionalRequestConflict', $metadata: { httpStatusCode: 409 } });
      }
      return real(command);
    };
    const adapter = createAwsWorkspaceAdapter({ workspaceId: 'alice', bucketName: 'data', tableName: 'app', ...doubles });
    expect(await adapter.putIfAbsent('oauth/claims/abc', asBytes({}))).toBe(true);
    doubles.s3Client.send = async () => { throw Object.assign(new Error('denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }); };
    await expect(adapter.putIfAbsent('oauth/claims/def', asBytes({}))).rejects.toThrow('denied');
  });
});
