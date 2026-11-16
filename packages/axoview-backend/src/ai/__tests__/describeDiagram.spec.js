/**
 * The API's copy of describeDiagram (workspace MCP read_diagram) gives the same
 * as axoview-lib's (src/agent/describe.ts), which the app uses: both are
 * checked against __fixtures__/describe.contract.json.
 */
import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describeDiagram, DESCRIBE_LIMITS } from '../describeDiagram.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const contract = JSON.parse(fs.readFileSync(path.join(HERE, '../__fixtures__/describe.contract.json'), 'utf8'));

describe('describeDiagram contract shared with axoview-lib', () => {
  it.each(contract.cases.map((c) => [c.name, c]))('%s', (_name, c) => {
    expect(describeDiagram(c.model, c.options)).toEqual(c.expected);
  });

  it('cuts off at the limits and says so', () => {
    const items = Array.from({ length: DESCRIBE_LIMITS.nodes + 1 }, (_, i) => ({ id: `n${i}`, name: `N${i}` }));
    const result = describeDiagram({ title: 'T', icons: [], items, views: [{ id: 'p', name: 'P', items: items.map((it, i) => ({ id: it.id, tile: { x: i, y: 0 } })) }] });
    expect(result.nodes).toHaveLength(DESCRIBE_LIMITS.nodes);
    expect(result.truncated).toBe(true);
  });

  it('survives a malformed document', () => {
    expect(describeDiagram({ views: 'nope', items: null })).toMatchObject({ title: 'Untitled', nodes: [], pages: [] });
  });
});
