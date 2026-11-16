#!/usr/bin/env node
// Rebuilds src/ai/corpus/manual.json from docs/manual/*.md (see src/ai/manual.js).
// Run after editing the manual: npm run ai:manual --workspace=packages/axoview-backend
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildManualCorpus } from '../src/ai/manual.js';

const manualDir = fileURLToPath(new URL('../../../docs/manual/', import.meta.url));
const outFile = fileURLToPath(new URL('../src/ai/corpus/manual.json', import.meta.url));

const pages = readdirSync(manualDir)
  .filter((name) => name.endsWith('.md'))
  .map((fileName) => ({ fileName, markdown: readFileSync(manualDir + fileName, 'utf8') }));
const corpus = buildManualCorpus(pages);
writeFileSync(outFile, `${JSON.stringify(corpus, null, 2)}\n`);
console.log(`Wrote ${corpus.chunks.length} chunks (version ${corpus.version}) to src/ai/corpus/manual.json`);
