/**
 * The vector side of manual search with in-memory fakes for Bedrock and
 * S3 Vectors: request shapes, batching, incremental indexing, rank fusion and
 * the keyword fallback. No AWS call is made.
 */
import { describe, expect, jest, test } from '@jest/globals';
import { createEmbedder, EMBED_DIMENSION } from '../embeddings.js';
import { createVectorIndex } from '../vectorIndex.js';
import { documentText, syncManualIndex } from '../docsIndexer.js';
import { createDocsSearch, fuseRankings } from '../docsSearch.js';
import { MANUAL_CHUNKS, PUBLIC_KNOWLEDGE } from '../rag.js';
import { runIndexManual } from '../../cli/index-manual.js';

const vec = (seed) => Array.from({ length: EMBED_DIMENSION }, (_, i) => ((seed * 31 + i) % 97) / 97);

/** An S3 Vectors index in memory, answering the API the client calls. */
function fakeIndex() {
  const store = new Map();
  const calls = [];
  const send = jest.fn(async (path, body) => {
    calls.push([path, body]);
    if (path === '/PutVectors') { for (const v of body.vectors) store.set(v.key, v); return null; }
    if (path === '/DeleteVectors') { for (const key of body.keys) store.delete(key); return null; }
    if (path === '/ListVectors') {
      const all = [...store.values()].map(({ key, metadata }) => ({ key, metadata }));
      const start = body.nextToken ? Number(body.nextToken) : 0;
      const page = all.slice(start, start + body.maxResults);
      return { vectors: page, ...(start + body.maxResults < all.length ? { nextToken: String(start + body.maxResults) } : {}) };
    }
    throw new Error(`unexpected ${path}`);
  });
  return { store, calls, index: createVectorIndex({ region: 'ap-southeast-1', bucket: 'axoview-dev-docs', index: 'manual', call: send }) };
}

describe('embeddings (Cohere Embed v3 on Bedrock)', () => {
  test('InvokeModel request shape, batches of 96, order kept', async () => {
    const call = jest.fn(async (_path, body) => ({ embeddings: body.texts.map((_, i) => vec(i)) }));
    const embed = createEmbedder({ region: 'ap-southeast-1', call });
    const out = await embed(Array.from({ length: 100 }, (_, i) => `text ${i}`), 'search_document');
    expect(out).toHaveLength(100);
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[0][0]).toBe('/model/cohere.embed-multilingual-v3/invoke');
    expect(call.mock.calls[0][1]).toMatchObject({ input_type: 'search_document', truncate: 'END' });
    expect(call.mock.calls[0][1].texts).toHaveLength(96);
  });

  test('rejects other models, unknown input types and malformed responses', async () => {
    expect(() => createEmbedder({ region: 'ap-southeast-1', modelId: 'amazon.titan-embed-text-v2:0', call: jest.fn() })).toThrow();
    const embed = createEmbedder({ region: 'ap-southeast-1', call: async () => ({ embeddings: [[1, 2, 3]] }) });
    await expect(embed(['x'], 'classification')).rejects.toThrow('Unknown embedding input type');
    await expect(embed(['x'], 'search_query')).rejects.toThrow('Unexpected embedding response');
  });
});

describe('vector index (S3 Vectors)', () => {
  test('QueryVectors asks for distance and metadata, with the filter', async () => {
    const send = jest.fn(async () => ({ vectors: [{ key: 'a', distance: 0.2 }] }));
    const index = createVectorIndex({ region: 'ap-southeast-1', bucket: 'axoview-dev-docs', index: 'manual', call: send });
    expect(await index.query([0.5, 0.25], { topK: 5, filter: { audience: 'public' } })).toEqual([{ key: 'a', distance: 0.2 }]);
    expect(send).toHaveBeenCalledWith('/QueryVectors', {
      vectorBucketName: 'axoview-dev-docs', indexName: 'manual', queryVector: { float32: [0.5, 0.25] },
      topK: 5, returnDistance: true, returnMetadata: true, filter: { audience: 'public' }
    });
  });

  test('put and delete batch at 500; list follows nextToken', async () => {
    const { calls, index } = fakeIndex();
    await index.put(Array.from({ length: 1200 }, (_, i) => ({ key: `k${i}`, data: [i], metadata: { hash: 'h' } })));
    expect(calls.filter(([path]) => path === '/PutVectors').map(([, body]) => body.vectors.length)).toEqual([500, 500, 200]);
    expect(await index.list()).toHaveLength(1200);
    await index.delete(Array.from({ length: 700 }, (_, i) => `k${i}`));
    expect(calls.filter(([path]) => path === '/DeleteVectors').map(([, body]) => body.keys.length)).toEqual([500, 200]);
  });

  test('refuses names S3 Vectors would reject', () => {
    expect(() => createVectorIndex({ region: 'ap-southeast-1', bucket: 'Bad_Name', index: 'manual', call: jest.fn() })).toThrow();
  });
});

describe('docs indexer', () => {
  const chunks = MANUAL_CHUNKS.slice(0, 5);

  test('first run embeds everything; a second run embeds nothing', async () => {
    const { store, index } = fakeIndex();
    const embed = jest.fn(async (texts) => texts.map((_, i) => vec(i)));
    expect(await syncManualIndex({ chunks, embed, index })).toEqual({ added: 5, updated: 0, removed: 0, unchanged: 0 });
    expect(embed).toHaveBeenCalledWith(chunks.map(documentText), 'search_document');
    expect(store.get(chunks[0].id).metadata).toEqual({ audience: 'public', hash: chunks[0].hash });

    embed.mockClear();
    expect(await syncManualIndex({ chunks, embed, index })).toEqual({ added: 0, updated: 0, removed: 0, unchanged: 5 });
    expect(embed).not.toHaveBeenCalled();
  });

  test('a changed section is re-embedded and a removed one deleted', async () => {
    const { store, index } = fakeIndex();
    const embed = jest.fn(async (texts) => texts.map((_, i) => vec(i)));
    await syncManualIndex({ chunks, embed, index });
    const next = [{ ...chunks[0], hash: 'changed' }, ...chunks.slice(1, 4)];
    embed.mockClear();
    expect(await syncManualIndex({ chunks: next, embed, index })).toEqual({ added: 0, updated: 1, removed: 1, unchanged: 3 });
    expect(embed.mock.calls[0][0]).toHaveLength(1);
    expect(store.has(chunks[4].id)).toBe(false);
  });

  test('the CLI skips when unconfigured and reports failures without throwing', async () => {
    const lines = [];
    expect(await runIndexManual({}, { log: (line) => lines.push(line) })).toBe('skipped');
    const failing = () => ({ list: async () => { throw Object.assign(new Error('no'), { awsType: 'AccessDeniedException', status: 403 }); } });
    expect(await runIndexManual(
      { AWS_REGION: 'ap-southeast-1', AI_DOCS_VECTOR_BUCKET: 'axoview-dev-docs', AI_DOCS_VECTOR_INDEX: 'manual' },
      { log: (line) => lines.push(line), createIndex: failing, createEmbed: () => async () => [] }
    )).toBe('failed');
    expect(lines).toEqual([
      'axoview_docs_index result=skipped reason=not_configured',
      expect.stringMatching(/^axoview_docs_index result=failed index=axoview-dev-docs\/manual manual=\w+ reason=AccessDeniedException status=403$/)
    ]);
  });
});

describe('hybrid manual search', () => {
  test('reciprocal rank fusion rewards agreement between the rankings', () => {
    expect(fuseRankings([['a', 'b', 'c'], ['c', 'a']]).map(({ id }) => id)).toEqual(['a', 'c', 'b']);
  });

  const zoom = 'canvas-zooming';
  const vectorFor = (keys) => ({
    embed: async () => [vec(1)],
    index: { query: jest.fn(async () => keys) }
  });

  test('a question phrased in other words reaches the right section through the vector side', async () => {
    const question = 'diagram is too big, I cannot see everything';
    const keywordOnly = await createDocsSearch()(question);
    expect(keywordOnly.items.map((item) => item.id)).not.toContain(zoom);
    const { embed, index } = vectorFor([{ key: zoom, distance: 0.31 }, { key: 'canvas-panning-moving-around', distance: 0.42 }]);
    const hybrid = await createDocsSearch({ embed, index })(question);
    expect(hybrid.mode).toBe('hybrid');
    expect(hybrid.items.map((item) => item.id)).toContain(zoom);
    expect(index.query).toHaveBeenCalledWith(expect.any(Array), { topK: 10, filter: { audience: 'public' } });
  });

  test('stale keys from another release and distant matches are ignored', async () => {
    const { embed, index } = vectorFor([{ key: 'removed-section', distance: 0.1 }, { key: zoom, distance: 0.9 }]);
    const result = await createDocsSearch({ embed, index })('weather forecast Paris tomorrow');
    expect(result).toEqual({ items: [], mode: 'hybrid' });
  });

  test('a vector failure falls back to keyword search and says so', async () => {
    const warn = jest.fn();
    const search = createDocsSearch({
      embed: async () => { throw Object.assign(new Error('x'), { awsType: 'ThrottlingException' }); },
      index: { query: jest.fn() },
      log: { warn }
    });
    const result = await search('how do I connect two items');
    expect(result.mode).toBe('keyword');
    expect(result.vectorError).toBe('ThrottlingException');
    expect(result.items[0].id).toBe('connectors-connecting-two-items');
    expect(warn).toHaveBeenCalled();
  });

  test('results are always shipped sections with their public source', async () => {
    const { items } = await createDocsSearch()('export a png');
    for (const item of items) {
      expect(PUBLIC_KNOWLEDGE.some((chunk) => chunk.id === item.id && chunk.text === item.text)).toBe(true);
      expect(item.source).toMatch(/^docs\/manual\//);
    }
  });
});

describe('deployed-search evaluation CLI', () => {
  test('scores both question sets with whatever search it is given', async () => {
    const { evalDocsSearch } = await import('../../cli/eval-docs-search.js');
    const lines = [];
    const summary = await evalDocsSearch({ search: createDocsSearch(), log: (line) => lines.push(line) });
    expect(summary.regression.top3).toBe(summary.regression.total);
    expect(summary.held_out.top3).toBeGreaterThanOrEqual(16);
    expect(lines.filter((line) => line.startsWith('axoview_docs_eval'))).toHaveLength(2);
  });
});
