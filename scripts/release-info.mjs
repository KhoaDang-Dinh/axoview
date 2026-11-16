#!/usr/bin/env node
/**
 * Reads a commit message on stdin and prints the release's PR and title as
 * GitHub Actions outputs ("pr=<n>" and "title=<text>", "-" for no PR), for
 * "Push images to ECR" to bake into the backend image:
 *
 *   git log -1 --format=%B "$APP_SHA" | node scripts/release-info.mjs >> "$GITHUB_OUTPUT"
 */
import { describeCommitMessage } from '../packages/axoview-backend/src/releaseInfo.js';

let message = '';
for await (const chunk of process.stdin) message += chunk;
const { pr, title } = describeCommitMessage(message);
process.stdout.write(`pr=${pr ?? '-'}\ntitle=${title ?? '-'}\n`);
