#!/usr/bin/env node
/**
 * Publishes the user manual (docs/manual) with the app, for any AI or person
 * to read without signing in:
 *
 *   /docs/manual/<page>.md   each page, without front matter or authoring comments
 *   /llms.txt                the index (llmstxt.org): one link and summary per page
 *   /llms-full.txt           the whole manual in one file
 *
 * Writes into packages/axoview-app/public (gitignored outputs), which the app
 * build copies to the site root. Run by the app's build and start scripts.
 * Usage: node scripts/build-public-docs.mjs [publicDir]
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontMatter } from '../packages/axoview-backend/src/ai/manual.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const manualDir = join(root, 'docs/manual');
const publicDir = process.argv[2] || join(root, 'packages/axoview-app/public');

// The order a reader would take; pages not listed follow alphabetically.
const ORDER = ['getting-started', 'canvas', 'nodes', 'connectors', 'shapes-and-text',
  'organising', 'sharing-and-export', 'settings-and-shortcuts', 'ai-assistant'];

function publicPage(markdown) {
  const { body } = parseFrontMatter(markdown);
  return `${body.replace(/^<!--\s*keywords:[^>]*-->\n?/gim, '').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

function buildPublicDocs(pages) {
  const sorted = [...pages].sort((a, b) => {
    const rank = (page) => (ORDER.includes(page.slug) ? ORDER.indexOf(page.slug) : ORDER.length);
    return rank(a) - rank(b) || a.slug.localeCompare(b.slug);
  });
  const llms = [
    '# Axoview',
    '',
    '> Axoview is a free diagram editor for isometric (3D-looking) and flat 2D diagrams of cloud, network and software architecture, with AWS, Google Cloud, Azure and Kubernetes icons. This is its user manual: one task per section.',
    '',
    'The editor runs at /app. Every page below is plain Markdown; /llms-full.txt is the whole manual in one file.',
    '',
    '## User manual',
    '',
    ...sorted.map((page) => `- [${page.title}](/docs/manual/${page.slug}.md)${page.description ? `: ${page.description}` : ''}`),
    '',
    '## Optional',
    '',
    '- [Full manual](/llms-full.txt): every page above, concatenated',
    ''
  ].join('\n');
  const full = [
    '# Axoview user manual',
    '',
    ...sorted.map((page) => `<!-- /docs/manual/${page.slug}.md -->\n\n${page.text.trim()}\n`)
  ].join('\n');
  return { llms, full, pages: sorted.map((page) => ({ path: `docs/manual/${page.slug}.md`, text: page.text })) };
}

function main() {
  const pages = readdirSync(manualDir)
    .filter((name) => name.endsWith('.md') && name !== 'README.md')
    .map((name) => {
      const markdown = readFileSync(join(manualDir, name), 'utf8');
      const { meta } = parseFrontMatter(markdown);
      return { slug: name.replace(/\.md$/, ''), title: meta.title || name, description: meta.description, text: publicPage(markdown) };
    });
  const out = buildPublicDocs(pages);
  rmSync(join(publicDir, 'docs/manual'), { recursive: true, force: true });
  mkdirSync(join(publicDir, 'docs/manual'), { recursive: true });
  for (const page of out.pages) writeFileSync(join(publicDir, page.path), page.text);
  writeFileSync(join(publicDir, 'llms.txt'), out.llms);
  writeFileSync(join(publicDir, 'llms-full.txt'), out.full);
  console.log(`build-public-docs: ${out.pages.length} pages, llms.txt and llms-full.txt in ${publicDir}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
