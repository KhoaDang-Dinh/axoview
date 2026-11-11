/**
 * Model routing rules (modelRouting.js, ADR 0061): which
 * of the two models answers a message, the strong model paired with a
 * configured one, and that a routing setup problem is reported, never thrown.
 */
import { describe, expect, test } from '@jest/globals';
import {
  chooseModel, resolveRouting, strongModelFor, LONG_HISTORY_MESSAGES, LONG_QUESTION_CHARS
} from '../modelRouting.js';

describe('which model answers', () => {
  test('a plain question goes to the fast model', () => {
    expect(chooseModel({ questionChars: 40, historyMessages: 2 })).toEqual({ tier: 'fast', reason: 'plain' });
    expect(chooseModel()).toEqual({ tier: 'fast', reason: 'plain' });
  });

  test('a shared page, workspace tools, a long question or a long conversation go to the strong one', () => {
    expect(chooseModel({ sharedPage: true })).toEqual({ tier: 'strong', reason: 'page' });
    expect(chooseModel({ workspaceTools: true })).toEqual({ tier: 'strong', reason: 'tools' });
    expect(chooseModel({ questionChars: LONG_QUESTION_CHARS + 1 })).toEqual({ tier: 'strong', reason: 'long' });
    expect(chooseModel({ historyMessages: LONG_HISTORY_MESSAGES })).toEqual({ tier: 'strong', reason: 'long' });
  });

  test('the limits themselves stay on the fast model; the first matching rule names the reason', () => {
    expect(chooseModel({ questionChars: LONG_QUESTION_CHARS, historyMessages: LONG_HISTORY_MESSAGES - 1 }).tier).toBe('fast');
    expect(chooseModel({ sharedPage: true, workspaceTools: true, questionChars: 5000 }).reason).toBe('page');
    expect(chooseModel({ workspaceTools: true, questionChars: 5000 }).reason).toBe('tools');
  });
});

describe('the strong model', () => {
  test('is Nova Pro, called the same way as the configured model', () => {
    expect(strongModelFor('apac.amazon.nova-lite-v1:0')).toBe('apac.amazon.nova-pro-v1:0');
    expect(strongModelFor('amazon.nova-micro-v1:0')).toBe('amazon.nova-pro-v1:0');
    expect(strongModelFor('us.amazon.nova-lite-v1:0')).toBe('us.amazon.nova-pro-v1:0');
  });

  test('there is none above Nova Pro, or for an ID that is not a Nova model', () => {
    expect(strongModelFor('apac.amazon.nova-pro-v1:0')).toBeNull();
    expect(strongModelFor('anthropic.claude-3-haiku')).toBeNull();
    expect(strongModelFor(undefined)).toBeNull();
  });
});

describe('setting it up', () => {
  const base = { enabled: true, region: 'ap-southeast-1', modelId: 'apac.amazon.nova-lite-v1:0' };

  test('off: nothing to route to, and no problem', () => {
    expect(resolveRouting({ ...base, enabled: false })).toEqual({ strongModelId: null });
  });

  test('on: Nova Pro by default, or the configured strong model', () => {
    expect(resolveRouting(base)).toEqual({ strongModelId: 'apac.amazon.nova-pro-v1:0' });
    expect(resolveRouting({ ...base, modelId: 'apac.amazon.nova-micro-v1:0', strongModelId: 'apac.amazon.nova-lite-v1:0' }))
      .toEqual({ strongModelId: 'apac.amazon.nova-lite-v1:0' });
  });

  test('a setup that cannot route says why instead of throwing', () => {
    expect(resolveRouting({ ...base, modelId: 'apac.amazon.nova-pro-v1:0' }).problem).toMatch(/already the strongest/);
    expect(resolveRouting({ ...base, strongModelId: 'apac.amazon.nova-lite-v1:0' }).problem).toMatch(/is the configured model/);
    expect(resolveRouting({ ...base, strongModelId: 'gpt-4' })).toMatchObject({ strongModelId: null, problem: expect.stringMatching(/approved Amazon Nova/) });
    expect(resolveRouting({ ...base, region: 'nowhere' })).toMatchObject({ strongModelId: null, problem: expect.stringMatching(/region/) });
  });
});
