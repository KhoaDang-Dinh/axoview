/**
 * Retrieval evaluation: questions a user would type, and the manual section
 * that answers each. No model is involved; this checks that retrieval puts the
 * right evidence in front of the model at all.
 *
 * CASES were written alongside the manual's section keywords: they are the
 * regression set. When one fails, fix the manual's wording or keywords first,
 * the ranking second.
 *
 * HELD_OUT was written after the keywords and must not be tuned against: it is
 * the honest measure of how well lexical search generalises. Baseline at
 * introduction (BM25, 50 chunks): 17/20 in the top 3, 9/20 first. When it drops
 * below the gate, or the manual grows past a few hundred sections, that is the
 * signal to add embeddings (docs/ai/rag.md).
 */
import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { rankKnowledge, retrievePublicKnowledge } from '../rag.js';

const QUESTIONS = JSON.parse(readFileSync(new URL('../__fixtures__/retrieval-questions.json', import.meta.url), 'utf8'));
const CASES = QUESTIONS.regression.map(({ question, section }) => [question, section]);
const HELD_OUT = QUESTIONS.held_out.map(({ question, section }) => [question, section]);

describe('manual retrieval', () => {
  test.each(CASES)('%s -> %s in the top 3', (question, expected) => {
    const ids = retrievePublicKnowledge(question).map((doc) => doc.id);
    expect(ids).toContain(expected);
  });

  test('top-1 accuracy stays above 80%', () => {
    const hits = CASES.filter(([question, expected]) => rankKnowledge(question)[0]?.item.id === expected);
    expect(hits.length / CASES.length).toBeGreaterThanOrEqual(0.8);
  });

  test('held-out questions: at least 80% have the answer in the top 3', () => {
    const hits = HELD_OUT.filter(([question, expected]) =>
      retrievePublicKnowledge(question).some((doc) => doc.id === expected));
    expect(hits.length / HELD_OUT.length).toBeGreaterThanOrEqual(0.8);
  });

  test('an off-topic question retrieves nothing', () => {
    expect(retrievePublicKnowledge('weather forecast Paris tomorrow')).toEqual([]);
  });
});
