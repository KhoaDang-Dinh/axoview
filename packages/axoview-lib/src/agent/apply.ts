/**
 * applyOperations: carry out the ready steps of a plan on a copy of the model.
 *
 * This is the write primitive for the later approve-and-apply stage (ADR 0052
 * addendum 2026-11-04). Nothing calls it from the UI or the API yet: today the
 * assistant only recommends, and the user makes each change. It exists now so
 * the vocabulary is proven end to end (every operation produces a model the
 * schema accepts) before anything is allowed to write.
 *
 * Pure: returns a new model and the steps; the input is never mutated. Only
 * `ready` steps change anything, so applying a plan does exactly what
 * planOperations reported.
 */
import { produce } from 'immer';
import type { Coords } from 'src/types';
import type { Model, View } from 'src/types';
import { modelSchema } from 'src/schemas/model';
import { generateId as defaultGenerateId } from 'src/utils/common';
import { getConnectorsByViewItem } from 'src/utils/isoMath';
import { collectAnchorTiles, sweepDanglingAnchorRefs } from 'src/stores/reducers/anchorGraph';
import { connectorEnds, findView } from './describe';
import { runSteps, simulationFor, type PlanStep } from './plan';

export interface ApplyOptions {
  generateId?: () => string;
  /** The icon id for an add_node's icon hint; undefined leaves the item without one. */
  iconFor?: (hint: string | undefined) => string | undefined;
}

export interface ApplyResult {
  model: Model;
  steps: PlanStep[];
}

const SEARCH_RADIUS = 30;

/** Occupied tiles, each with a one-tile margin, so a new item never touches another. */
const occupiedTiles = (view: View) => {
  const taken = new Set<string>();
  const mark = ({ x, y }: Coords) => {
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) taken.add(`${x + dx},${y + dy}`);
  };
  view.items.forEach((item) => mark(item.tile));
  (view.textBoxes ?? []).forEach((box) => mark(box.tile));
  return taken;
};

/** The nearest free tile to `origin`, searching outward ring by ring. */
export const freeTileNear = (view: View, origin: Coords): Coords => {
  const taken = occupiedTiles(view);
  for (let radius = 0; radius <= SEARCH_RADIUS; radius++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        const tile = { x: origin.x + dx * 2, y: origin.y + dy * 2 };
        if (!taken.has(`${tile.x},${tile.y}`)) return tile;
      }
    }
  }
  return { x: origin.x + SEARCH_RADIUS * 2 + 2, y: origin.y };
};

const centroid = (view: View): Coords => {
  if (view.items.length === 0) return { x: 0, y: 0 };
  const sum = view.items.reduce((acc, item) => ({ x: acc.x + item.tile.x, y: acc.y + item.tile.y }), { x: 0, y: 0 });
  return { x: Math.round(sum.x / view.items.length), y: Math.round(sum.y / view.items.length) };
};

const tileOf = (view: View, itemId: string | undefined) =>
  itemId ? view.items.find((item) => item.id === itemId)?.tile : undefined;

export function applyOperations(
  model: Model,
  viewId: string | undefined,
  operations: unknown[],
  { generateId = defaultGenerateId, iconFor = () => undefined }: ApplyOptions = {}
): ApplyResult {
  const target = findView(model, viewId);
  if (!target) throw new Error('applyOperations: the diagram has no pages');
  const created = new Map<number, string>();
  let steps: PlanStep[] = [];

  const next = produce(model, (draft) => {
    const view = draft.views.find((candidate) => candidate.id === target.id)!;
    const item = (id: string) => draft.items.find((candidate) => candidate.id === id)!;
    const sim = simulationFor(model, target.id);

    steps = runSteps(sim, operations, (index) => {
      if (!created.has(index)) created.set(index, generateId());
      return created.get(index)!;
    }, (step) => {
      const operation = step.operation!;
      switch (operation.op) {
        case 'add_node': {
          const [id, nearId] = step.nodeIds;
          const icon = iconFor(operation.icon);
          draft.items.push({ id, name: operation.name, label: operation.name, ...(icon ? { icon } : {}) });
          view.items.unshift({ id, tile: freeTileNear(view, tileOf(view, nearId) ?? centroid(view)) });
          break;
        }
        case 'rename_node': {
          const node = item(step.nodeIds[0]);
          node.name = operation.name;
          node.label = operation.name;
          break;
        }
        case 'set_notes': {
          const node = item(step.nodeIds[0]);
          node.notes = node.notes ? `${node.notes}\n\n${operation.notes}` : operation.notes;
          break;
        }
        case 'remove_node': {
          const id = step.nodeIds[0];
          const doomed = getConnectorsByViewItem(id, view.connectors ?? []);
          view.items = view.items.filter((viewItem) => viewItem.id !== id);
          if (view.connectors) {
            const kept = view.connectors.filter((connector) => !doomed.some((c) => c.id === connector.id));
            view.connectors = sweepDanglingAnchorRefs(kept, collectAnchorTiles(doomed)).connectors;
          }
          // The model item goes too, unless another page still shows it.
          if (!draft.views.some((page) => page.items.some((viewItem) => viewItem.id === id))) {
            draft.items = draft.items.filter((candidate) => candidate.id !== id);
          }
          break;
        }
        case 'connect': {
          const [from, to] = step.nodeIds;
          view.connectors = view.connectors ?? [];
          view.connectors.push({
            id: generateId(),
            ...(draft.colors[0] ? { color: draft.colors[0].id } : {}),
            ...(operation.label ? { name: operation.label } : {}),
            anchors: [
              { id: generateId(), ref: { item: from } },
              { id: generateId(), ref: { item: to } }
            ]
          });
          break;
        }
        case 'disconnect': {
          const [a, b] = step.nodeIds;
          const doomed = (view.connectors ?? []).filter((connector) => {
            const ends = connectorEnds(connector);
            return ends && ((ends.from === a && ends.to === b) || (ends.from === b && ends.to === a));
          });
          if (view.connectors) {
            const kept = view.connectors.filter((connector) => !doomed.includes(connector));
            view.connectors = sweepDanglingAnchorRefs(kept, collectAnchorTiles(doomed)).connectors;
          }
          break;
        }
        case 'group': {
          const tiles = step.nodeIds.map((id) => tileOf(view, id)).filter((tile): tile is Coords => !!tile);
          const xs = tiles.map((tile) => tile.x);
          const ys = tiles.map((tile) => tile.y);
          view.rectangles = view.rectangles ?? [];
          view.rectangles.push({
            id: generateId(),
            name: operation.name,
            from: { x: Math.min(...xs) - 1, y: Math.min(...ys) - 1 },
            to: { x: Math.max(...xs) + 1, y: Math.max(...ys) + 1 }
          });
          break;
        }
        case 'add_note': {
          const near = tileOf(view, step.nodeIds[0]);
          view.textBoxes = view.textBoxes ?? [];
          view.textBoxes.push({
            id: generateId(),
            tile: freeTileNear(view, near ?? centroid(view)),
            content: operation.text
          });
          break;
        }
      }
    });
  });

  const check = modelSchema.safeParse(next);
  if (!check.success) {
    throw new Error(`applyOperations produced an invalid model: ${check.error.issues[0]?.message}`);
  }
  return { model: next, steps };
}
