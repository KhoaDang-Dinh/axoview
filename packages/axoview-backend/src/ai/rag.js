/**
 * Public-only retrieval for the AI assistant: the user manual (docs/manual),
 * chunked ahead of time into corpus/manual.json (see manual.js). No private
 * diagram, workspace or user data is reachable from here.
 *
 * Ranking is BM25 over each chunk's title, text and page keywords. Lexical
 * search fits a corpus this size (tens of chunks, written in the UI's own
 * words) and runs in-process: no embedding model or vector store to pay for or
 * keep in sync. The retrieval evaluation in __tests__/rag.eval.spec.js says
 * when that stops being true.
 */
import { readFileSync } from 'node:fs';

const MANUAL = JSON.parse(readFileSync(new URL('./corpus/manual.json', import.meta.url), 'utf8'));

export const PUBLIC_KNOWLEDGE = Object.freeze(MANUAL.chunks
  .filter((chunk) => chunk.audience === 'public')
  .map((chunk) => Object.freeze({ ...chunk })));

const STOP_WORDS = new Set(['the', 'and', 'for', 'what', 'how', 'where', 'with', 'from', 'can',
  'are', 'does', 'this', 'that', 'you', 'your', 'into', 'about', 'want', 'way', 'do', 'to', 'in',
  'on', 'of', 'is', 'it', 'an', 'my', 'me', 'or', 'be', 'by', 'at', 'as', 'if', 'so', 'there',
  'when', 'which', 'its', 'then', 'them', 'they', 'use', 'using', 'one', 'all', 'get', 'any', 'i']);

// Light stemming: plural and -ing/-ed endings, so "connectors"/"connecting"/
// "connected" meet "connector"/"connect".
const stem = (word) => word
  .replace(/(?<=..)(ies)$/, 'y')
  .replace(/(?<=...)(ing|ed)$/, '')
  .replace(/(?<=...)s$/, '');

export function tokenize(text) {
  return (String(text).toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token))
    .map(stem);
}

function buildIndex(corpus) {
  const docs = corpus.map((item) => {
    // Title and keywords count twice: they name the task the section answers.
    const tokens = [
      ...tokenize(item.title), ...tokenize(item.title),
      ...tokenize((item.keywords || []).join(' ')),
      ...tokenize(item.text)
    ];
    const tf = new Map();
    for (const token of tokens) tf.set(token, (tf.get(token) || 0) + 1);
    return { item, tf, length: tokens.length };
  });
  const df = new Map();
  for (const doc of docs) for (const token of doc.tf.keys()) df.set(token, (df.get(token) || 0) + 1);
  const avgLength = docs.reduce((sum, doc) => sum + doc.length, 0) / Math.max(1, docs.length);
  return { docs, df, avgLength, size: docs.length };
}

const indexes = new WeakMap();
const indexFor = (corpus) => {
  if (!indexes.has(corpus)) indexes.set(corpus, buildIndex(corpus));
  return indexes.get(corpus);
};

const K1 = 1.2;
const B = 0.75;

/** BM25 scores for every chunk with at least one query term, best first. */
export function rankKnowledge(query, corpus = PUBLIC_KNOWLEDGE) {
  const { docs, df, avgLength, size } = indexFor(corpus);
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) return [];
  return docs.map(({ item, tf, length }) => {
    let score = 0;
    for (const term of terms) {
      const frequency = tf.get(term);
      if (!frequency) continue;
      const idf = Math.log(1 + (size - df.get(term) + 0.5) / (df.get(term) + 0.5));
      score += idf * (frequency * (K1 + 1)) / (frequency + K1 * (1 - B + B * length / avgLength));
    }
    return { item, score };
  })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id));
}

export function retrievePublicKnowledge(query, { limit = 3, corpus = PUBLIC_KNOWLEDGE } = {}) {
  return rankKnowledge(query, corpus)
    .filter(({ item }) => /^[a-z0-9_-]+$/.test(item.id))
    .slice(0, Math.min(3, Math.max(0, limit)))
    .map(({ item: { id, title, text } }) => ({ id, title, text: text.slice(0, 900) }));
}

export function composeRagContext(items) {
  return items.map((item) => `[source:${item.id}] ${item.title}\n${item.text}`).join('\n\n').slice(0, 3500);
}
