/**
 * The release an API image was built from: its commit, and the pull request
 * that commit merged. "Push images to ECR" (.github/workflows/push-images.yml)
 * reads them from the commit message at build time and bakes them into the
 * backend image (AXOVIEW_RELEASE_* in Dockerfile.backend). No GitHub access is
 * needed afterwards, so this works whether the repository is public or private.
 *
 * /healthz returns them only to callers inside the cluster (the release
 * reporter in infra_website): a private repository's PR titles are not for the
 * internet, and every request through CloudFront or the ALB carries an
 * X-Forwarded-For header that its sender cannot remove.
 */

const TITLE_MAX = 120;

/** One line, single spaces, at most TITLE_MAX characters; null when empty. */
export function cleanTitle(text) {
  let title = String(text ?? '').split(/\s+/).filter(Boolean).join(' ');
  if (title.length > TITLE_MAX) title = `${title.slice(0, TITLE_MAX - 1).trimEnd()}…`;
  return title || null;
}

/**
 * { pr, title } from a commit message:
 * - a merge commit, "Merge pull request #<n> from <branch>" then a blank line
 *   and the PR title (GitHub's default);
 * - a squash merge, "<title> (#<n>)";
 * - any other commit: no PR, its subject.
 */
export function describeCommitMessage(message) {
  const lines = String(message ?? '').split(/\r?\n/).map((line) => line.trim());
  const subject = lines[0] ?? '';
  const merge = /^Merge pull request #(\d+) from \S+/.exec(subject);
  if (merge) {
    const body = lines.slice(1).find((line) => line) ?? '';
    return { pr: merge[1], title: cleanTitle(body || subject) };
  }
  const squash = /\s*\(#(\d+)\)$/.exec(subject);
  if (squash) return { pr: squash[1], title: cleanTitle(subject.slice(0, squash.index)) };
  return { pr: null, title: cleanTitle(subject) };
}

/** The release baked into this image, or null (a build without the stamps). */
export function releaseInfo(env = process.env) {
  const commit = env.AXOVIEW_RELEASE_COMMIT?.trim();
  if (!commit) return null;
  return {
    commit,
    pr: env.AXOVIEW_RELEASE_PR?.trim() || null,
    title: cleanTitle(env.AXOVIEW_RELEASE_TITLE)
  };
}

/** The release for this request: only for a caller inside the cluster. */
export function releaseInfoFor(req, env = process.env) {
  if (req.headers?.['x-forwarded-for']) return null;
  return releaseInfo(env);
}
