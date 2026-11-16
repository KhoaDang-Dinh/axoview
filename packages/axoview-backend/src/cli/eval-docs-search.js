#!/usr/bin/env node
/**
 * Measures the manual search this deployment runs (keyword + vector when an
 * index is configured) on the questions in src/ai/__fixtures__/retrieval-questions.json.
 * Run it in a dev API pod after the docs-index Job, before changing
 * AI_DOCS_MAX_DISTANCE:
 *   kubectl -n axoview exec deploy/axoview-api -- node src/cli/eval-docs-search.js
 * Prints one summary line per question set and every miss; costs one
 * embedding call per question.
 */
import { readFileSync } from 'node:fs';
import { docsSearchFromEnv } from '../ai/docsSearch.js';

export async function evalDocsSearch({ search = docsSearchFromEnv(), log = console.log } = {}) {
  const sets = JSON.parse(readFileSync(new URL('../ai/__fixtures__/retrieval-questions.json', import.meta.url), 'utf8'));
  const summary = {};
  for (const name of ['regression', 'held_out']) {
    let top1 = 0;
    let top3 = 0;
    let mode = 'keyword';
    for (const { question, section } of sets[name]) {
      const result = await search(question, { limit: 3 });
      mode = result.mode;
      const ids = result.items.map((item) => item.id);
      if (ids[0] === section) top1++;
      if (ids.includes(section)) top3++;
      else log(`  miss [${name}] ${JSON.stringify(question)} -> ${ids.join(', ') || '(nothing)'}; expected ${section}`);
    }
    summary[name] = { top1, top3, total: sets[name].length, mode };
    log(`axoview_docs_eval set=${name} mode=${mode} top1=${top1}/${sets[name].length} top3=${top3}/${sets[name].length}`);
  }
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await evalDocsSearch();
}
