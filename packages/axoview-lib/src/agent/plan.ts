/**
 * planOperations: check proposed operations against one page without changing
 * it, and turn each into a step a person can follow.
 *
 * Operations run in order against a simulated page, so a later step can refer
 * to an item an earlier step adds or renames. A step that cannot be carried out
 * (an item that is not on the page, a name two items share, a connection that
 * already exists) is `not_applicable` with the reason; it does not stop the
 * steps after it. A malformed operation is `invalid`.
 */
import type { Model } from 'src/types';
import { connectorEnds, findView } from './describe';
import {
  diagramOperationSchema, MAX_OPERATIONS,
  type DiagramOperation, type NodeRef
} from './operations';

export type StepStatus = 'ready' | 'not_applicable' | 'invalid';

export interface PlanStep {
  index: number;
  status: StepStatus;
  /** The validated operation; absent when `invalid`. */
  operation?: DiagramOperation;
  /** What the step does, naming items as the page shows them. */
  summary: string;
  /** Why a step is not applicable or invalid. */
  problem?: string;
  /** How to do it by hand in the editor. */
  howTo: string;
  /** docs/manual section (corpus id) that explains the task. */
  manualSection: string;
  /** The model's reason for suggesting it, if it gave one. */
  reason?: string;
  /** Items the step touches (existing ids, or ids it creates in applyOperations). */
  nodeIds: string[];
}

interface SimNode { id: string; name: string; label?: string }
interface SimConnection { id: string; from: string; to: string }

export interface Simulation {
  nodes: Map<string, SimNode>;
  connections: SimConnection[];
}

const quote = (text: string) => `“${text}”`;
const shown = (node: SimNode) => node.label || node.name;
const norm = (text: string) => text.trim().toLowerCase().replace(/\s+/g, ' ');

const HOW_TO: Record<DiagramOperation['op'], { howTo: string; manualSection: string }> = {
  add_node: {
    howTo: 'Press N to open Elements, search for the icon and drag it onto the canvas; then press F2 to name it.',
    manualSection: 'nodes-adding-an-item'
  },
  rename_node: {
    howTo: 'Select the item and press F2, or double-click it and change Name and Label.',
    manualSection: 'nodes-name-and-label'
  },
  set_notes: {
    howTo: 'Double-click the item (or right-click → Add/edit note) and type in Notes.',
    manualSection: 'nodes-item-details-and-notes'
  },
  remove_node: {
    howTo: 'Select the item and press Delete (Backspace on Mac). Its connectors go with it.',
    manualSection: 'nodes-deleting-an-item'
  },
  connect: {
    howTo: 'Press C, click the first item, then click the second. Double-click the connector to give it a name.',
    manualSection: 'connectors-connecting-two-items'
  },
  disconnect: {
    howTo: 'Click the connector between them and press Delete (Backspace on Mac).',
    manualSection: 'connectors-deleting-a-connector'
  },
  group: {
    howTo: 'Press R and drag a rectangle around the items; double-click it to give it a name.',
    manualSection: 'shapes-and-text-drawing-a-rectangle'
  },
  add_note: {
    howTo: 'Press T, click where the text should go and type.',
    manualSection: 'shapes-and-text-adding-a-text-box'
  }
};

export function simulationFor(model: Model, viewId?: string): Simulation {
  const view = findView(model, viewId);
  const items = new Map(model.items.map((item) => [item.id, item]));
  const nodes = new Map<string, SimNode>();
  for (const viewItem of view?.items ?? []) {
    const item = items.get(viewItem.id);
    if (item) nodes.set(item.id, { id: item.id, name: item.name, ...(item.label ? { label: item.label } : {}) });
  }
  const connections = (view?.connectors ?? []).flatMap((connector) => {
    const ends = connectorEnds(connector);
    return ends ? [{ id: connector.id, ...ends }] : [];
  });
  return { nodes, connections };
}

/** A node by id, or by a name/label that exactly one node on the page has. */
export function resolveNode(sim: Simulation, ref: NodeRef): { node: SimNode } | { problem: string } {
  if ('id' in ref) {
    const node = sim.nodes.get(ref.id);
    return node ? { node } : { problem: 'That item is not on this page.' };
  }
  const wanted = norm(ref.name);
  const matches = [...sim.nodes.values()].filter((node) =>
    norm(node.name) === wanted || (node.label !== undefined && norm(node.label) === wanted));
  if (matches.length === 1) return { node: matches[0] };
  if (matches.length === 0) return { problem: `There is no item called ${quote(ref.name)} on this page.` };
  return { problem: `${matches.length} items are called ${quote(ref.name)}; rename one so they can be told apart.` };
}

const refText = (ref: NodeRef) => ('name' in ref ? quote(ref.name) : 'an item');
const connected = (sim: Simulation, a: string, b: string) => sim.connections.filter((connection) =>
  (connection.from === a && connection.to === b) || (connection.from === b && connection.to === a));

/**
 * Runs the operations against `sim` (mutated), calling `onReady` for each
 * ready step before the simulation records its effect. `newId(index)` names
 * the item an add_node creates.
 */
export function runSteps(
  sim: Simulation,
  operations: unknown[],
  newId: (index: number) => string,
  onReady?: (step: PlanStep) => void
): PlanStep[] {
  return operations.slice(0, MAX_OPERATIONS).map((raw, index) => {
    const parsed = diagramOperationSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        index, status: 'invalid' as const, summary: 'Unrecognised suggestion',
        problem: parsed.error.issues[0]?.message ?? 'Invalid operation',
        howTo: '', manualSection: '', nodeIds: []
      };
    }
    const operation = parsed.data;
    const base = {
      index, operation, ...HOW_TO[operation.op],
      ...(operation.reason ? { reason: operation.reason } : {})
    };
    const notApplicable = (summary: string, problem: string, nodeIds: string[] = []): PlanStep =>
      ({ ...base, status: 'not_applicable', summary, problem, nodeIds });
    const ready = (summary: string, nodeIds: string[]): PlanStep => {
      const step: PlanStep = { ...base, status: 'ready', summary, nodeIds };
      onReady?.(step);
      return step;
    };

    switch (operation.op) {
      case 'add_node': {
        const near = operation.near ? resolveNode(sim, operation.near) : null;
        const summary = `Add an item ${quote(operation.name)}` +
          (operation.icon ? ` (icon: ${operation.icon})` : '') +
          (near && 'node' in near ? ` near ${quote(shown(near.node))}` : '');
        if (near && 'problem' in near) return notApplicable(summary, near.problem);
        const existing = resolveNode(sim, { name: operation.name });
        if (!('problem' in existing) || existing.problem.includes('items are called')) {
          return notApplicable(summary, `An item called ${quote(operation.name)} is already on this page.`);
        }
        const node = { id: newId(index), name: operation.name, label: operation.name };
        const step = ready(summary, [node.id, ...(near && 'node' in near ? [near.node.id] : [])]);
        sim.nodes.set(node.id, node);
        return step;
      }
      case 'rename_node': {
        const target = resolveNode(sim, operation.node);
        if ('problem' in target) return notApplicable(`Rename ${refText(operation.node)} to ${quote(operation.name)}`, target.problem);
        const summary = `Rename ${quote(shown(target.node))} to ${quote(operation.name)}`;
        if (norm(shown(target.node)) === norm(operation.name)) return notApplicable(summary, 'It already has that name.', [target.node.id]);
        const step = ready(summary, [target.node.id]);
        sim.nodes.set(target.node.id, { ...target.node, name: operation.name, label: operation.name });
        return step;
      }
      case 'set_notes': {
        const target = resolveNode(sim, operation.node);
        if ('problem' in target) return notApplicable(`Add notes to ${refText(operation.node)}`, target.problem);
        return ready(`Add notes to ${quote(shown(target.node))}: ${quote(operation.notes)}`, [target.node.id]);
      }
      case 'remove_node': {
        const target = resolveNode(sim, operation.node);
        if ('problem' in target) return notApplicable(`Remove ${refText(operation.node)}`, target.problem);
        const step = ready(`Remove ${quote(shown(target.node))} and its connections`, [target.node.id]);
        sim.nodes.delete(target.node.id);
        sim.connections = sim.connections.filter((c) => c.from !== target.node.id && c.to !== target.node.id);
        return step;
      }
      case 'connect': {
        const from = resolveNode(sim, operation.from);
        const to = resolveNode(sim, operation.to);
        const names = (a: typeof from, aRef: NodeRef) => ('node' in a ? quote(shown(a.node)) : refText(aRef));
        const summary = `Connect ${names(from, operation.from)} to ${names(to, operation.to)}` +
          (operation.label ? `, named ${quote(operation.label)}` : '');
        if ('problem' in from) return notApplicable(summary, from.problem);
        if ('problem' in to) return notApplicable(summary, to.problem);
        if (from.node.id === to.node.id) return notApplicable(summary, 'An item cannot be connected to itself.', [from.node.id]);
        if (connected(sim, from.node.id, to.node.id).length > 0) {
          return notApplicable(summary, 'They are already connected.', [from.node.id, to.node.id]);
        }
        const step = ready(summary, [from.node.id, to.node.id]);
        sim.connections.push({ id: `planned-${index}`, from: from.node.id, to: to.node.id });
        return step;
      }
      case 'disconnect': {
        const from = resolveNode(sim, operation.from);
        const to = resolveNode(sim, operation.to);
        const summary = `Remove the connection between ${'node' in from ? quote(shown(from.node)) : refText(operation.from)}` +
          ` and ${'node' in to ? quote(shown(to.node)) : refText(operation.to)}`;
        if ('problem' in from) return notApplicable(summary, from.problem);
        if ('problem' in to) return notApplicable(summary, to.problem);
        const existing = connected(sim, from.node.id, to.node.id);
        if (existing.length === 0) return notApplicable(summary, 'They are not connected.', [from.node.id, to.node.id]);
        const step = ready(summary, [from.node.id, to.node.id]);
        sim.connections = sim.connections.filter((connection) => !existing.includes(connection));
        return step;
      }
      case 'group': {
        const targets = operation.nodes.map((ref) => resolveNode(sim, ref));
        const found = targets.flatMap((target) => ('node' in target ? [target.node] : []));
        const summary = `Draw a rectangle ${quote(operation.name)} around ` +
          (found.length ? found.map((node) => quote(shown(node))).join(', ') : 'the listed items');
        const missing = targets.find((target) => 'problem' in target);
        if (missing && 'problem' in missing) return notApplicable(summary, missing.problem);
        return ready(summary, [...new Set(found.map((node) => node.id))]);
      }
      case 'add_note': {
        const near = operation.near ? resolveNode(sim, operation.near) : null;
        const preview = operation.text.length > 80 ? `${operation.text.slice(0, 79)}…` : operation.text;
        const summary = `Add a text box ${quote(preview)}` +
          (near && 'node' in near ? ` near ${quote(shown(near.node))}` : '');
        if (near && 'problem' in near) return notApplicable(summary, near.problem);
        return ready(summary, near && 'node' in near ? [near.node.id] : []);
      }
    }
  });
}

/**
 * Checks `operations` (untrusted: straight from a model) against the page
 * `viewId` of `model` (default: the first page) without changing anything.
 * At most MAX_OPERATIONS are considered.
 */
export function planOperations(model: Model, viewId: string | undefined, operations: unknown[]): PlanStep[] {
  if (!Array.isArray(operations)) return [];
  return runSteps(simulationFor(model, viewId), operations, (index) => `planned-node-${index}`);
}
