import { describe, expect, test } from '@jest/globals';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildManualCorpus, chunkManualPage, MAX_CHUNK_TEXT, parseFrontMatter, toPlainText } from '../manual.js';

const manualDir = fileURLToPath(new URL('../../../../../docs/manual/', import.meta.url));
const pages = () => readdirSync(manualDir).filter((name) => name.endsWith('.md'))
  .map((fileName) => ({ fileName, markdown: readFileSync(manualDir + fileName, 'utf8') }));
const shipped = JSON.parse(readFileSync(new URL('../corpus/manual.json', import.meta.url), 'utf8'));

describe('manual corpus', () => {
  test('corpus/manual.json matches docs/manual (run npm run ai:manual after editing the manual)', () => {
    expect(shipped).toEqual(buildManualCorpus(pages()));
  });

  test('every chunk is retrievable and stands on its own', () => {
    expect(shipped.chunks.length).toBeGreaterThan(30);
    for (const chunk of shipped.chunks) {
      expect(chunk.id).toMatch(/^[a-z0-9_-]{1,64}$/);
      expect(chunk.text.length).toBeGreaterThan(40);
      expect(chunk.text.length).toBeLessThanOrEqual(MAX_CHUNK_TEXT);
      expect(chunk.title).toContain(' › ');
      expect(chunk.audience).toBe('public');
      expect(chunk.source).toMatch(/^docs\/manual\/[a-z0-9-]+\.md#[a-z0-9-]+$/);
      // A section that leans on another ("as above") is useless retrieved alone.
      expect(chunk.text).not.toMatch(/\b(as above|see above|as below|previous section)\b/i);
    }
  });

  test('the README is the index, not a chunk', () => {
    expect(shipped.chunks.some((chunk) => chunk.source.includes('README'))).toBe(false);
  });
});

describe('chunking', () => {
  test('front matter keys and lists', () => {
    const { meta, body } = parseFrontMatter('---\ntitle: Connectors\naudience: public\nkeywords: [line, arrow]\n---\n# X\n');
    expect(meta).toEqual({ title: 'Connectors', audience: 'public', keywords: ['line', 'arrow'] });
    expect(body).toBe('# X\n');
  });

  test('markdown becomes plain text, tables become rows', () => {
    expect(toPlainText('Press **C** or `c`, see [docs](x.md).\n\n| Key | Tool |\n|---|---|\n| S | Select |'))
      .toBe('Press C or c, see docs.\n\nKey — Tool\nS — Select');
  });

  test('section keywords are kept for ranking and removed from the text', () => {
    const [chunk] = chunkManualPage('k.md', '## Joining\n<!-- keywords: arrow, line -->\nUse the connector tool.\n');
    expect(chunk.keywords).toEqual(['arrow', 'line']);
    expect(chunk.text).toBe('Use the connector tool.');
  });

  test('one chunk per ## section; text before the first section is skipped', () => {
    const chunks = chunkManualPage('demo.md', '---\ntitle: Demo\n---\n# Demo\nIntro.\n\n## First task\nDo the first thing.\n\n## Second task\nDo the second.\n');
    expect(chunks.map((chunk) => [chunk.id, chunk.title, chunk.text])).toEqual([
      ['demo-first-task', 'Demo › First task', 'Do the first thing.'],
      ['demo-second-task', 'Demo › Second task', 'Do the second.']
    ]);
  });

  test('a long section splits at paragraphs, every part within the limit', () => {
    const paragraph = 'Sentence about connectors. '.repeat(20).trim();
    const chunks = chunkManualPage('long.md', `## Long\n${Array(5).fill(paragraph).join('\n\n')}\n`);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.id)).toEqual(chunks.map((_, i) => (i ? `long-long-${i + 1}` : 'long-long')));
    expect(chunks.every((chunk) => chunk.text.length <= MAX_CHUNK_TEXT)).toBe(true);
  });

  test('duplicate section ids are an error, not a silent overwrite', () => {
    expect(() => buildManualCorpus([{ fileName: 'a.md', markdown: '## Same\nOne thing here.\n\n## Same\nAnother thing.\n' }]))
      .toThrow(/Duplicate manual chunk id a-same/);
  });
});
