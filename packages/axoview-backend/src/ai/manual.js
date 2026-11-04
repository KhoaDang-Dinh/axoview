/**
 * The user manual (docs/manual/*.md) as retrieval chunks for the AI assistant.
 *
 * One chunk per `##` section, so a chunk answers one task and makes sense on its
 * own; a section longer than MAX_CHUNK_TEXT is split at paragraph boundaries.
 * The chunks are built ahead of time (`npm run ai:manual`) into
 * corpus/manual.json, which ships in the image: the API never reads Markdown at
 * runtime, and a test fails when the JSON is older than the Markdown.
 */
import { createHash } from 'node:crypto';

// rag.js and chat.js reject longer reference text, and the prompt holds 3.
export const MAX_CHUNK_TEXT = 900;
const ID_MAX = 64;

const slug = (text) => text.toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, ID_MAX);

/** `---` front matter (`title`, `audience`): `key: value` and `key: [a, b]` lines only. */
export function parseFrontMatter(markdown) {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(markdown);
  if (!match) return { meta: {}, body: markdown };
  const meta = {};
  for (const line of match[1].split('\n')) {
    const pair = /^([a-z][a-z0-9_]*):\s*(.*)$/i.exec(line.trim());
    if (!pair) continue;
    const [, key, raw] = pair;
    meta[key] = /^\[.*\]$/.test(raw)
      ? raw.slice(1, -1).split(',').map((value) => value.trim()).filter(Boolean)
      : raw.trim();
  }
  return { meta, body: markdown.slice(match[0].length) };
}

/** Markdown to the plain text the model reads: no emphasis, links or table rules. */
export function toPlainText(markdown) {
  return markdown
    .split('\n')
    .filter((line) => !/^\|?\s*:?-{3,}/.test(line.trim()))   // table separator rows
    .map((line) => line.trim().startsWith('|')
      ? line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim()).join(' — ')
      : line)
    .join('\n')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitLong(text) {
  if (text.length <= MAX_CHUNK_TEXT) return [text];
  const parts = [];
  let current = '';
  for (const paragraph of text.split(/\n\n/)) {
    const next = current ? `${current}\n\n${paragraph}` : paragraph;
    if (next.length <= MAX_CHUNK_TEXT) { current = next; continue; }
    if (current) parts.push(current);
    // A single paragraph over the limit is cut at a sentence end.
    let rest = paragraph;
    while (rest.length > MAX_CHUNK_TEXT) {
      const cut = rest.lastIndexOf('. ', MAX_CHUNK_TEXT - 1);
      const at = cut > MAX_CHUNK_TEXT / 2 ? cut + 1 : MAX_CHUNK_TEXT;
      parts.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    current = rest;
  }
  if (current) parts.push(current);
  return parts;
}

/**
 * chunkManualPage('connectors.md', markdown) -> [{ id, title, text, source,
 * audience, keywords, hash }]. Text before the first `##` (the page's `#` title
 * and intro) is not a chunk; put anything worth retrieving in a section.
 */
export function chunkManualPage(fileName, markdown) {
  const page = fileName.replace(/\.md$/, '');
  const { meta, body } = parseFrontMatter(markdown);
  const pageTitle = meta.title || page;
  const chunks = [];
  const sections = body.split(/^## /m).slice(1);
  for (const section of sections) {
    const newline = section.indexOf('\n');
    const heading = (newline === -1 ? section : section.slice(0, newline)).trim();
    // `<!-- keywords: a, b -->` in a section: words users type for this task
    // that the text itself does not use. Not shown to the model.
    let keywords = [];
    const raw = (newline === -1 ? '' : section.slice(newline + 1))
      .replace(/<!--\s*keywords:\s*([^>]*?)\s*-->\n?/gi, (_, list) => {
        keywords = keywords.concat(list.split(',').map((word) => word.trim()).filter(Boolean));
        return '';
      });
    const text = toPlainText(raw);
    if (!text) continue;
    const anchor = slug(heading);
    splitLong(text).forEach((part, index) => {
      const id = slug(`${page}-${anchor}${index ? `-${index + 1}` : ''}`);
      chunks.push({
        id,
        title: `${pageTitle} › ${heading}`,
        text: part,
        source: `docs/manual/${fileName}#${anchor}`,
        audience: meta.audience || 'public',
        keywords,
        hash: createHash('sha256').update(`${part}\n${keywords.join(',')}`).digest('hex').slice(0, 12)
      });
    });
  }
  return chunks;
}

/** pages: [{ fileName, markdown }] in a stable order -> the corpus document. */
export function buildManualCorpus(pages) {
  const chunks = pages
    .filter(({ fileName }) => fileName !== 'README.md')
    .sort((a, b) => a.fileName.localeCompare(b.fileName))
    .flatMap(({ fileName, markdown }) => chunkManualPage(fileName, markdown));
  const ids = new Set();
  for (const chunk of chunks) {
    if (ids.has(chunk.id)) throw new Error(`Duplicate manual chunk id ${chunk.id}: rename a heading`);
    ids.add(chunk.id);
  }
  return {
    description: 'Generated from docs/manual by `npm run ai:manual` in packages/axoview-backend. Do not edit.',
    version: createHash('sha256').update(chunks.map((chunk) => chunk.hash).join(',')).digest('hex').slice(0, 12),
    chunks
  };
}
