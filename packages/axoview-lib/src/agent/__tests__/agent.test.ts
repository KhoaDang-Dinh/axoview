/**
 * @jest-environment node
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { produce } from 'immer';
import { model as fixture } from 'src/fixtures/model';
import { modelSchema } from 'src/schemas/model';
import type { Model } from 'src/types';
import {
  applyOperations, describeDiagram, diagramOperationSchema, DESCRIBE_LIMITS, MAX_OPERATIONS,
  OPERATION_KINDS, planOperations
} from '..';

// node1 "Node1" (0,0), node2 "Node2" (0,4), node3 "Node3" (0,-4);
// connectors node1-node2, node2-node3; rectangle1 and rectangle2 cover (0,0)-(2,2).
const model = fixture as Model;
const ids = () => { let n = 0; return () => `id-${++n}`; };

// One ready operation of every kind, against the fixture page.
const ONE_OF_EACH: Record<string, unknown> = {
  add_node: { op: 'add_node', name: 'New' },
  rename_node: { op: 'rename_node', node: { id: 'node1' }, name: 'Renamed' },
  set_notes: { op: 'set_notes', node: { id: 'node1' }, notes: 'n' },
  remove_node: { op: 'remove_node', node: { id: 'node3' } },
  connect: { op: 'connect', from: { id: 'node1' }, to: { id: 'node3' } },
  disconnect: { op: 'disconnect', from: { id: 'node1' }, to: { id: 'node2' } },
  group: { op: 'group', nodes: [{ id: 'node1' }], name: 'G' },
  add_note: { op: 'add_note', text: 'Hello' }
};

describe('describeDiagram', () => {
  test('names, connections and what each rectangle encloses', () => {
    const page = describeDiagram(model, { viewId: 'view1' });
    expect(page.page).toEqual({ id: 'view1', name: 'View1' });
    expect(page.nodes.map((node) => node.name)).toEqual(['Node1', 'Node2', 'Node3']);
    expect(page.nodes[0]).toMatchObject({ id: 'node1', icon: 'icon1', description: 'Node1Description' });
    expect(page.connections).toEqual([
      { id: 'connector1', from: 'node1', to: 'node2' },
      { id: 'connector2', from: 'node2', to: 'node3' }
    ]);
    expect(page.groups[0]).toEqual({ id: 'rectangle1', contains: ['node1'] });
    expect(page.truncated).toBe(false);
  });

  test('never includes notes, links or styling', () => {
    const withPrivate = produce(model, (draft) => {
      draft.items[0].notes = 'the admin password is hunter2';
      draft.items[0].link = 'https://internal.example';
    });
    const text = JSON.stringify(describeDiagram(withPrivate));
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('internal.example');
    expect(text).not.toContain('tile');
  });

  test('strips markup, clips long text and flags truncation', () => {
    const many = produce(model, (draft) => {
      draft.items[0].description = `<b>${'x'.repeat(500)}</b>`;
      for (let i = 0; i < DESCRIBE_LIMITS.nodes + 5; i++) {
        draft.items.push({ id: `extra${i}`, name: `Extra ${i}` });
        draft.views[0].items.push({ id: `extra${i}`, tile: { x: 100 + i * 2, y: 0 } });
      }
    });
    const page = describeDiagram(many);
    expect(page.nodes).toHaveLength(DESCRIBE_LIMITS.nodes);
    expect(page.truncated).toBe(true);
    expect(page.nodes[0].description).not.toContain('<b>');
    expect(page.nodes[0].description!.length).toBeLessThanOrEqual(DESCRIBE_LIMITS.text);
  });
});

describe('planOperations', () => {
  const plan = (operations: unknown[]) => planOperations(model, 'view1', operations);

  test('a valid connection is ready, with a summary and how-to', () => {
    const [step] = plan([{ op: 'connect', from: { name: 'Node1' }, to: { name: 'node3' }, label: 'HTTPS', reason: 'Clients call it' }]);
    expect(step).toMatchObject({
      status: 'ready', summary: 'Connect “Node1” to “Node3”, named “HTTPS”',
      manualSection: 'connectors-connecting-two-items', reason: 'Clients call it', nodeIds: ['node1', 'node3']
    });
    expect(step.howTo).toMatch(/Press C/);
  });

  test('says why a step does not apply', () => {
    const steps = plan([
      { op: 'connect', from: { name: 'Node1' }, to: { name: 'Node2' } },
      { op: 'connect', from: { name: 'Node1' }, to: { name: 'Database' } },
      { op: 'connect', from: { id: 'node1' }, to: { id: 'node1' } },
      { op: 'disconnect', from: { name: 'Node1' }, to: { name: 'Node3' } },
      { op: 'add_node', name: 'node2' },
      { op: 'rename_node', node: { name: 'Node1' }, name: 'node1' }
    ]);
    expect(steps.map((step) => [step.status, step.problem])).toEqual([
      ['not_applicable', 'They are already connected.'],
      ['not_applicable', 'There is no item called “Database” on this page.'],
      ['not_applicable', 'An item cannot be connected to itself.'],
      ['not_applicable', 'They are not connected.'],
      ['not_applicable', 'An item called “node2” is already on this page.'],
      ['not_applicable', 'It already has that name.']
    ]);
  });

  test('two items with the same name are ambiguous', () => {
    const twins = produce(model, (draft) => { draft.items[2].name = 'Node1'; });
    const [step] = planOperations(twins, 'view1', [{ op: 'remove_node', node: { name: 'Node1' } }]);
    expect(step.problem).toBe('2 items are called “Node1”; rename one so they can be told apart.');
  });

  test('matches the label shown on the canvas as well as the name', () => {
    const labelled = produce(model, (draft) => { draft.items[0].label = 'Web server'; });
    const [step] = planOperations(labelled, 'view1', [{ op: 'remove_node', node: { name: 'web  SERVER' } }]);
    expect(step).toMatchObject({ status: 'ready', nodeIds: ['node1'], summary: 'Remove “Web server” and its connections' });
  });

  test('later steps see what earlier steps did', () => {
    const steps = plan([
      { op: 'add_node', name: 'Cache', icon: 'redis', near: { name: 'Node1' } },
      { op: 'connect', from: { name: 'Node1' }, to: { name: 'Cache' } },
      { op: 'remove_node', node: { name: 'Node2' } },
      { op: 'connect', from: { name: 'Node1' }, to: { name: 'Node2' } },
      { op: 'rename_node', node: { name: 'Node3' }, name: 'Queue' },
      { op: 'group', nodes: [{ name: 'Queue' }, { name: 'Cache' }], name: 'Private subnet' }
    ]);
    expect(steps.map((step) => step.status)).toEqual(['ready', 'ready', 'ready', 'not_applicable', 'ready', 'ready']);
    expect(steps[0].summary).toBe('Add an item “Cache” (icon: redis) near “Node1”');
    expect(steps[5].summary).toBe('Draw a rectangle “Private subnet” around “Queue”, “Cache”');
  });

  test('malformed suggestions are invalid, and at most MAX_OPERATIONS are read', () => {
    const steps = plan([{ op: 'delete_everything' }, { op: 'connect', from: 'Node1' }, ...Array(20).fill({ op: 'add_note', text: 'x' })]);
    expect(steps).toHaveLength(MAX_OPERATIONS);
    expect(steps.slice(0, 2).map((step) => step.status)).toEqual(['invalid', 'invalid']);
  });

  test('every how-to points at a section of the user manual', () => {
    const corpus: { chunks: { id: string }[] } = JSON.parse(readFileSync(
      join(__dirname, '../../../../axoview-backend/src/ai/corpus/manual.json'), 'utf8'
    ));
    const sections = new Set(corpus.chunks.map((chunk) => chunk.id));
    const steps = OPERATION_KINDS.map((kind) => plan([ONE_OF_EACH[kind]])[0]);
    for (const step of steps) expect(sections).toContain(step.manualSection);
  });

  test('never changes the model', () => {
    const before = JSON.stringify(model);
    plan([{ op: 'remove_node', node: { name: 'Node1' } }, { op: 'add_node', name: 'X' }]);
    expect(JSON.stringify(model)).toBe(before);
  });
});

describe('applyOperations', () => {
  test('does exactly the ready steps and returns a valid model', () => {
    const { model: next, steps } = applyOperations(model, 'view1', [
      { op: 'add_node', name: 'Cache', icon: 'redis', near: { name: 'Node1' } },
      { op: 'connect', from: { name: 'Node1' }, to: { name: 'Cache' }, label: 'reads' },
      { op: 'connect', from: { name: 'Node1' }, to: { name: 'Node2' } }
    ], { generateId: ids(), iconFor: (hint) => (hint === 'redis' ? 'icon2' : undefined) });

    expect(steps.map((step) => step.status)).toEqual(['ready', 'ready', 'not_applicable']);
    expect(modelSchema.safeParse(next).success).toBe(true);
    expect(next.items.find((item) => item.id === 'id-1')).toEqual({ id: 'id-1', name: 'Cache', label: 'Cache', icon: 'icon2' });
    const placed = next.views[0].items.find((item) => item.id === 'id-1')!;
    for (const other of next.views[0].items.filter((item) => item.id !== 'id-1')) {
      expect(Math.max(Math.abs(placed.tile.x - other.tile.x), Math.abs(placed.tile.y - other.tile.y))).toBeGreaterThan(1);
    }
    const connector = next.views[0].connectors!.at(-1)!;
    expect(connector).toMatchObject({ name: 'reads', color: model.colors[0].id });
    expect(connector.anchors.map((anchor) => anchor.ref)).toEqual([{ item: 'node1' }, { item: 'id-1' }]);
    expect(model.items).toHaveLength(3);
  });

  test('removing an item removes its connectors and the item', () => {
    const { model: next } = applyOperations(model, 'view1', [{ op: 'remove_node', node: { name: 'Node2' } }]);
    expect(next.items.map((item) => item.id)).toEqual(['node1', 'node3']);
    expect(next.views[0].connectors).toEqual([]);
    expect(modelSchema.safeParse(next).success).toBe(true);
  });

  test('disconnect, group, rename, notes and a text box', () => {
    const { model: next } = applyOperations(model, 'view1', [
      { op: 'disconnect', from: { name: 'Node3' }, to: { name: 'Node2' } },
      { op: 'group', nodes: [{ name: 'Node2' }, { name: 'Node3' }], name: 'Tier' },
      { op: 'rename_node', node: { name: 'Node1' }, name: 'Gateway' },
      { op: 'set_notes', node: { name: 'Gateway' }, notes: 'Public entry point' },
      { op: 'add_note', text: 'Legend: arrows show calls', near: { name: 'Gateway' } }
    ], { generateId: ids() });
    const view = next.views[0];
    expect(view.connectors!.map((connector) => connector.id)).toEqual(['connector1']);
    expect(view.rectangles!.at(-1)).toMatchObject({ name: 'Tier', from: { x: -1, y: -5 }, to: { x: 1, y: 5 } });
    expect(next.items[0]).toMatchObject({ name: 'Gateway', label: 'Gateway', notes: 'Public entry point' });
    expect(view.textBoxes!.at(-1)).toMatchObject({ content: 'Legend: arrows show calls' });
    expect(modelSchema.safeParse(next).success).toBe(true);
  });

  test('every operation kind can be applied and keeps the model valid', () => {
    expect(Object.keys(ONE_OF_EACH).sort()).toEqual([...OPERATION_KINDS].sort());
    for (const kind of OPERATION_KINDS) {
      const { model: next, steps } = applyOperations(model, 'view1', [ONE_OF_EACH[kind]], { generateId: ids() });
      expect([kind, steps[0].status]).toEqual([kind, 'ready']);
      expect(modelSchema.safeParse(next).success).toBe(true);
    }
  });
});

describe('wire contract shared with the API', () => {
  // packages/axoview-backend validates suggestions with its own plain-JS
  // checker; both must accept and reject the same cases.
  const contract: { valid: unknown[]; invalid: unknown[] } = JSON.parse(readFileSync(
    join(__dirname, '../../../../axoview-backend/src/ai/__fixtures__/suggestions.contract.json'), 'utf8'
  ));
  const cases = (list: unknown[]): [string, unknown][] =>
    list.map((op) => [JSON.stringify(op).slice(0, 80), op]);

  test.each(cases(contract.valid))('accepts %s', (_name, op) => {
    expect(diagramOperationSchema.safeParse(op).success).toBe(true);
  });

  test.each(cases(contract.invalid))('rejects %s', (_name, op) => {
    expect(diagramOperationSchema.safeParse(op).success).toBe(false);
  });
});

describe('page description contract shared with the API', () => {
  // packages/axoview-backend describes a page for the workspace MCP server
  // (read_diagram) with its own plain-JS copy; both must give the same.
  const contract: { cases: { name: string; model: unknown; options: { viewId?: string }; expected: unknown }[] } =
    JSON.parse(readFileSync(
      join(__dirname, '../../../../axoview-backend/src/ai/__fixtures__/describe.contract.json'), 'utf8'
    ));

  test.each(contract.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(describeDiagram(c.model as Model, c.options)).toEqual(c.expected);
  });
});
