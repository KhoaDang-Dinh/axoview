/**
 * What one editor save costs in DynamoDB and S3 calls, and the saves that cost
 * nothing because nothing changed.
 *
 * Before: a save read the metadata item three times (the route's document
 * read, the conditional write's own check, the ETag lookup) and the S3 object
 * once, only to carry the share link over. Now the item carries the
 * server-owned fields and a content digest: one item read, one object write,
 * one item write. An unchanged save writes nothing and publishes nothing.
 */
import { createAwsWorkspaceAdapter } from '../adapters/aws.js';
import { contentHash } from '../diagramContent.js';
import { createDiagram, getDiagram, patchDiagram, saveDiagram, HttpError } from '../routes.js';
import { makeAwsDoubles } from './helpers/awsDoubles.js';
import { createMemoryAdapter, makeCtx } from './helpers/memoryAdapter.js';

const model = (extra = {}) => ({
  title: 'Network',
  icons: [],
  colors: [],
  items: [{ id: 'a', name: 'Web' }],
  views: [{ id: 'v1', name: 'Page 1', items: [{ id: 'a', tile: { x: 0, y: 0 } }] }],
  fitToScreen: true,
  ...extra
});

function setup() {
  const doubles = makeAwsDoubles();
  const adapter = createAwsWorkspaceAdapter({ workspaceId: 'alice', bucketName: 'data', tableName: 'app', ...doubles });
  return { doubles, adapter };
}

const save = (adapter, id, body, ifMatch) =>
  saveDiagram(adapter, { ...makeCtx({ params: { id }, body }), ifMatch });

const versionOf = (result) => Number(result.headers.ETag.slice(1, -1));

describe('editor save cost (DynamoDB + S3)', () => {
  test('a save is one item read, one object write and one item write: no object read', async () => {
    const { doubles, adapter } = setup();
    const created = await createDiagram(adapter, makeCtx({ body: { id: 'd1', ...model() } }));
    let version = versionOf(created);

    const counts = await doubles.count(async () => {
      const result = await save(adapter, 'd1', model({ title: 'Network v2' }), version);
      version = versionOf(result);
    });
    expect(counts).toEqual({ GetCommand: 1, PutObjectCommand: 1, PutCommand: 1 });
    expect(version).toBe(2);
  });

  test('the share link survives a save without the object being read', async () => {
    const { doubles, adapter } = setup();
    await createDiagram(adapter, makeCtx({ body: { id: 'd1', ...model() } }));
    // Sharing writes the uuid into the stored document (an internal write).
    const shared = await patchDiagram(adapter, makeCtx({ params: { id: 'd1' }, body: {} }));
    const item = doubles.rows.get('WORKSPACE#alice|DIAGRAM#d1');
    const objectKey = item.objectKey;
    const stored = JSON.parse(new TextDecoder().decode(doubles.objects.get(objectKey)));
    // Simulate the share route's write: same document plus a shareUuid.
    await adapter.put('diagrams/d1', new TextEncoder().encode(JSON.stringify({ ...stored, shareUuid: 'share_uuid_0123456789abc' })), {
      expectedVersion: versionOf(shared)
    });
    const version = doubles.rows.get('WORKSPACE#alice|DIAGRAM#d1').version;

    const counts = await doubles.count(() => save(adapter, 'd1', model({ title: 'edited' }), version));
    expect(counts.GetObjectCommand).toBeUndefined();
    const latest = doubles.rows.get('WORKSPACE#alice|DIAGRAM#d1');
    const saved = JSON.parse(new TextDecoder().decode(doubles.objects.get(latest.objectKey)));
    expect(saved.shareUuid).toBe('share_uuid_0123456789abc');
    expect(saved.created).toBe(stored.created);
    expect(saved.title).toBe('edited');
  });

  test('an item written before the fields were kept costs one object read, once', async () => {
    const { doubles, adapter } = setup();
    await createDiagram(adapter, makeCtx({ body: { id: 'd1', ...model() } }));
    const row = doubles.rows.get('WORKSPACE#alice|DIAGRAM#d1');
    delete row.owned;
    delete row.contentHash;
    const legacyObject = JSON.parse(new TextDecoder().decode(doubles.objects.get(row.objectKey)));
    doubles.objects.set(row.objectKey, new TextEncoder().encode(JSON.stringify({ ...legacyObject, shareUuid: 'legacy_uuid_0123456789ab' })));

    const first = await doubles.count(() => save(adapter, 'd1', model({ title: 'one' }), 1));
    expect(first).toEqual({ GetCommand: 1, GetObjectCommand: 1, PutObjectCommand: 1, PutCommand: 1 });
    const second = await doubles.count(() => save(adapter, 'd1', model({ title: 'two' }), 2));
    expect(second).toEqual({ GetCommand: 1, PutObjectCommand: 1, PutCommand: 1 });

    const latest = doubles.rows.get('WORKSPACE#alice|DIAGRAM#d1');
    expect(latest.owned.shareUuid).toBe('legacy_uuid_0123456789ab');
  });

  test('an unchanged save writes nothing, keeps the version and asks for no sync event', async () => {
    const { doubles, adapter } = setup();
    const created = await createDiagram(adapter, makeCtx({ body: { id: 'd1', ...model() } }));
    const version = versionOf(created);
    const objectsBefore = doubles.objects.size;

    let result;
    const counts = await doubles.count(async () => {
      // The client's body carries its own timestamp: not content.
      result = await save(adapter, 'd1', { ...model(), lastModified: 'whenever' }, version);
    });
    expect(counts).toEqual({ GetCommand: 1 });
    expect(result.body).toEqual({ success: true, id: 'd1', unchanged: true, lastModified: expect.any(String) });
    expect(result.sync).toBe(false);
    expect(versionOf(result)).toBe(version);
    expect(doubles.objects.size).toBe(objectsBefore);
  });

  test('an unchanged save from a client a version behind gets the current version, not a conflict', async () => {
    const { adapter } = setup();
    await createDiagram(adapter, makeCtx({ body: { id: 'd1', ...model() } }));
    const v2 = versionOf(await save(adapter, 'd1', model({ title: 'B' }), 1));
    // Another tab put back exactly what this one already has.
    const v3 = versionOf(await save(adapter, 'd1', model(), v2));
    const result = await save(adapter, 'd1', model(), v2);
    expect(result.body.unchanged).toBe(true);
    expect(versionOf(result)).toBe(v3);
  });

  test('a changed save on an old version is still refused', async () => {
    const { adapter } = setup();
    await createDiagram(adapter, makeCtx({ body: { id: 'd1', ...model() } }));
    await save(adapter, 'd1', model({ title: 'B' }), 1);
    await expect(save(adapter, 'd1', model({ title: 'C' }), 1)).rejects.toMatchObject({ status: 409 });
  });

  test('If-Match is still required, unchanged or not', async () => {
    const { adapter } = setup();
    await createDiagram(adapter, makeCtx({ body: { id: 'd1', ...model() } }));
    await expect(save(adapter, 'd1', model(), undefined)).rejects.toMatchObject({ status: 428 });
  });

  test('opening a diagram is one item read and one object read, with its version', async () => {
    const { doubles, adapter } = setup();
    await createDiagram(adapter, makeCtx({ body: { id: 'd1', ...model() } }));
    let result;
    const counts = await doubles.count(async () => {
      result = await getDiagram(adapter, makeCtx({ params: { id: 'd1' } }));
    });
    expect(counts).toEqual({ GetCommand: 1, GetObjectCommand: 1 });
    expect(result.headers.ETag).toBe('"1"');
    expect(result.body.title).toBe('Network');
    await expect(getDiagram(adapter, makeCtx({ params: { id: 'nope' } }))).rejects.toBeInstanceOf(HttpError);
  });

  test('a rename returns the new version, so the next save is not refused as stale', async () => {
    const { adapter } = setup();
    await createDiagram(adapter, makeCtx({ body: { id: 'd1', ...model() } }));
    const renamed = await patchDiagram(adapter, makeCtx({ params: { id: 'd1' }, body: { name: 'Renamed', title: 'Renamed' } }));
    expect(renamed.headers.ETag).toBe('"2"');
    await expect(save(adapter, 'd1', model({ title: 'Renamed', note: 'x' }), 2)).resolves.toMatchObject({ status: 200 });
  });
});

describe('unchanged saves on the fs store', () => {
  test('the second identical save is skipped', async () => {
    const adapter = createMemoryAdapter();
    let puts = 0;
    const put = adapter.put.bind(adapter);
    adapter.put = async (...args) => { puts += 1; return put(...args); };

    await save(adapter, 'd1', model());
    await save(adapter, 'd1', model({ title: 'changed' }));
    expect(puts).toBe(2);
    const again = await save(adapter, 'd1', model({ title: 'changed' }));
    expect(puts).toBe(2);
    expect(again.body.unchanged).toBe(true);
    expect(again.sync).toBe(false);
  });
});

describe('contentHash', () => {
  test('ignores the id, the timestamp and server-owned fields; sees everything else', async () => {
    const base = await contentHash(model());
    expect(await contentHash({ ...model(), id: 'x', lastModified: 'y', created: 'z', shareUuid: 'u', workspaceId: 'w' })).toBe(base);
    expect(await contentHash(model({ title: 'other' }))).not.toBe(base);
    expect(await contentHash(model({ items: [] }))).not.toBe(base);
  });
});
