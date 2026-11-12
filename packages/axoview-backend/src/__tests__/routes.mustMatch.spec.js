/**
 * A save that must not replace a state its author has not seen
 * (`ctx.mustMatch`): what approving an agent's proposal uses (server.js, ADR
 * 0059 addendum 2026-11-12). The author names the state the document was
 * built on; any other state refuses the save and leaves the diagram as it is.
 *
 *   versioned store (DynamoDB + S3): If-Match, checked by the conditional write
 *   store without versions (fs):     the lastModified the author loaded
 */
import { createAwsWorkspaceAdapter } from '../adapters/aws.js';
import { createDiagram, getDiagram, saveDiagram } from '../routes.js';
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
const failure = (promise) => promise.then(() => { throw new Error('expected a refusal'); }, (e) => ({ status: e.status, ...e.body }));
const strict = (adapter, body, base) =>
  saveDiagram(adapter, { ...makeCtx({ params: { id: 'd1' }, body }), mustMatch: true, ...base });
const stored = async (adapter) => (await getDiagram(adapter, makeCtx({ params: { id: 'd1' } }))).body;
const versionOf = (result) => Number(result.headers.ETag.slice(1, -1));

describe('a versioned store: If-Match', () => {
  async function setup() {
    const adapter = createAwsWorkspaceAdapter({ workspaceId: 'alice', bucketName: 'data', tableName: 'app', ...makeAwsDoubles() });
    const created = await createDiagram(adapter, makeCtx({ body: { id: 'd1', ...model() } }));
    return { adapter, version: versionOf(created) };
  }

  test('built on the current version: saved, and the answer names the new version', async () => {
    const { adapter, version } = await setup();
    const saved = await strict(adapter, model({ title: 'Approved' }), { ifMatch: version });
    expect(saved.status).toBe(200);
    expect(versionOf(saved)).toBe(version + 1);
    expect((await stored(adapter)).title).toBe('Approved');
  });

  test('built on an older version: 409, and the diagram keeps what was saved since', async () => {
    const { adapter, version } = await setup();
    await saveDiagram(adapter, { ...makeCtx({ params: { id: 'd1' }, body: model({ title: 'Edited elsewhere' }) }), ifMatch: version });
    expect(await failure(strict(adapter, model({ title: 'Approved' }), { ifMatch: version }))).toMatchObject({ status: 409 });
    expect((await stored(adapter)).title).toBe('Edited elsewhere');
  });

  test('no version named: 428, nothing written (a lastModified is not enough here)', async () => {
    const { adapter } = await setup();
    const before = await stored(adapter);
    expect(await failure(strict(adapter, model({ title: 'Approved' }), {}))).toMatchObject({ status: 428, reason: 'precondition-required' });
    expect(await failure(strict(adapter, model({ title: 'Approved' }), { ifUnmodified: before.lastModified })))
      .toMatchObject({ status: 428 });
    expect(await stored(adapter)).toEqual(before);
  });

  test('several built on the same version, at once: exactly one is saved', async () => {
    const { adapter, version } = await setup();
    const attempts = await Promise.allSettled(Array.from({ length: 12 }, (_, i) =>
      strict(adapter, model({ title: `Approval ${i}` }), { ifMatch: version })));
    const won = attempts.flatMap((a, i) => (a.status === 'fulfilled' ? [i] : []));
    expect(won).toHaveLength(1);
    for (const a of attempts.filter((x) => x.status === 'rejected')) expect(a.reason.status).toBe(409);
    expect((await stored(adapter)).title).toBe(`Approval ${won[0]}`);
  });
});

describe('a store without versions: the lastModified that was loaded', () => {
  async function setup() {
    const adapter = createMemoryAdapter();
    await createDiagram(adapter, makeCtx({ body: { id: 'd1', ...model() } }));
    return { adapter, loaded: (await stored(adapter)).lastModified };
  }

  test('built on the stored state: saved, with a new lastModified', async () => {
    const { adapter, loaded } = await setup();
    const saved = await strict(adapter, model({ title: 'Approved' }), { ifUnmodified: loaded });
    expect(saved.status).toBe(200);
    const after = await stored(adapter);
    expect(after.title).toBe('Approved');
    expect(saved.body.lastModified).toBe(after.lastModified);
    expect(Date.parse(after.lastModified)).toBeGreaterThan(Date.parse(loaded));
  });

  test('changed since it was loaded: 409, and the diagram keeps that change', async () => {
    const { adapter, loaded } = await setup();
    await saveDiagram(adapter, makeCtx({ params: { id: 'd1' }, body: model({ title: 'Edited elsewhere' }) }));
    expect(await failure(strict(adapter, model({ title: 'Approved' }), { ifUnmodified: loaded }))).toMatchObject({ status: 409, reason: 'conflict' });
    expect((await stored(adapter)).title).toBe('Edited elsewhere');
  });

  test('no state named: 428, nothing written (an If-Match means nothing here)', async () => {
    const { adapter } = await setup();
    const before = await stored(adapter);
    expect(await failure(strict(adapter, model({ title: 'Approved' }), {}))).toMatchObject({ status: 428, reason: 'precondition-required' });
    expect(await failure(strict(adapter, model({ title: 'Approved' }), { ifMatch: 1 }))).toMatchObject({ status: 428 });
    expect(await stored(adapter)).toEqual(before);
  });

  test('several built on the same state, at once: exactly one is saved', async () => {
    const { adapter, loaded } = await setup();
    const attempts = await Promise.allSettled(Array.from({ length: 12 }, (_, i) =>
      strict(adapter, model({ title: `Approval ${i}` }), { ifUnmodified: loaded })));
    const won = attempts.flatMap((a, i) => (a.status === 'fulfilled' ? [i] : []));
    expect(won).toHaveLength(1);
    for (const a of attempts.filter((x) => x.status === 'rejected')) expect(a.reason.status).toBe(409);
    expect((await stored(adapter)).title).toBe(`Approval ${won[0]}`);
  });

  test('every save gets a later lastModified than the one it replaces, even in the same millisecond', async () => {
    const { adapter } = await setup();
    const stamps = [];
    for (let i = 0; i < 30; i++) {
      stamps.push((await saveDiagram(adapter, makeCtx({ params: { id: 'd1' }, body: model({ title: `t${i}` }) }))).body.lastModified);
    }
    expect(new Set(stamps).size).toBe(30);
    expect([...stamps].sort()).toEqual(stamps);
  });
});
