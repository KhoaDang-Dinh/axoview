import { describe, it, expect } from '@jest/globals';
import { cleanTitle, describeCommitMessage, releaseInfo, releaseInfoFor } from '../releaseInfo.js';

const SHA = '2b267892dcadf6811003657ee63db1e5e4f616e9';
const STAMPED = {
  AXOVIEW_RELEASE_COMMIT: SHA,
  AXOVIEW_RELEASE_PR: '53',
  AXOVIEW_RELEASE_TITLE: 'fix(app): keep the page id stable'
};

describe('describeCommitMessage', () => {
  it('a merge commit: the PR and the title after the blank line', () => {
    expect(describeCommitMessage(
      'Merge pull request #53 from KhoaDang-Dinh/fix/stable-page-id-on-open\n\nfix(app): keep the page id stable\n'
    )).toEqual({ pr: '53', title: 'fix(app): keep the page id stable' });
  });

  it('a merge commit without a body keeps its subject', () => {
    expect(describeCommitMessage('Merge pull request #9 from a/b')).toEqual({ pr: '9', title: 'Merge pull request #9 from a/b' });
  });

  it('a squash merge', () => {
    expect(describeCommitMessage('feat(api): mobile sign-in (#31)\n\nbody')).toEqual({ pr: '31', title: 'feat(api): mobile sign-in' });
  });

  it('any other commit: no PR, its subject', () => {
    expect(describeCommitMessage('chore: bump\r\n\r\nmore')).toEqual({ pr: null, title: 'chore: bump' });
    expect(describeCommitMessage('')).toEqual({ pr: null, title: null });
  });

  it('a title is one line and bounded', () => {
    const title = cleanTitle(`a  b\tc ${'x'.repeat(300)}`);
    expect(title.startsWith('a b c x')).toBe(true);
    expect(title).toHaveLength(120);
    expect(title.endsWith('…')).toBe(true);
  });
});

describe('releaseInfo', () => {
  it('reads the stamps baked into the image', () => {
    expect(releaseInfo(STAMPED)).toEqual({ commit: SHA, pr: '53', title: 'fix(app): keep the page id stable' });
  });

  it('a build without them has no release; empty parts are null', () => {
    expect(releaseInfo({})).toBeNull();
    expect(releaseInfo({ AXOVIEW_RELEASE_COMMIT: SHA, AXOVIEW_RELEASE_PR: '', AXOVIEW_RELEASE_TITLE: '' }))
      .toEqual({ commit: SHA, pr: null, title: null });
  });
});

describe('releaseInfoFor', () => {
  it('a caller inside the cluster gets it', () => {
    expect(releaseInfoFor({ headers: {} }, STAMPED)).toEqual(releaseInfo(STAMPED));
  });

  it('a request through CloudFront or the ALB (X-Forwarded-For) does not', () => {
    expect(releaseInfoFor({ headers: { 'x-forwarded-for': '203.0.113.7' } }, STAMPED)).toBeNull();
  });
});
