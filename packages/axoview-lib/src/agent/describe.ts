/**
 * describeDiagram: one page of a diagram as compact, bounded data an AI model
 * can read: items by name and icon, which items are connected, which items a
 * rectangle encloses, and the page's text. No tiles, colours, styling, links
 * or notes: they cost tokens, say nothing about the architecture, and notes
 * are where people keep things they did not mean to share.
 *
 * Everything here is user-authored text. Callers must hand it to a model as
 * untrusted data, never as instructions.
 */
import type { Model, View, ViewItem, Rectangle } from 'src/types';

export const DESCRIBE_LIMITS = {
  nodes: 150,
  connections: 300,
  groups: 50,
  notes: 30,
  text: 200
} as const;

export interface DiagramDescription {
  title: string;
  page: { id: string; name: string };
  pages: { id: string; name: string }[];
  nodes: { id: string; name: string; label?: string; icon?: string; description?: string }[];
  connections: { id: string; from: string; to: string; name?: string }[];
  groups: { id: string; name?: string; contains: string[] }[];
  notes: { id: string; text: string }[];
  /** True when a limit cut something off; the model should say so. */
  truncated: boolean;
}

const clip = (text: string | undefined, max: number = DESCRIBE_LIMITS.text) => {
  if (!text) return undefined;
  const flat = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!flat) return undefined;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const iconName = (model: Model, iconId: string | undefined) => {
  if (!iconId) return undefined;
  return clip(model.icons.find((icon) => icon.id === iconId)?.name ?? iconId, 60);
};

/** Ends of a connector that are attached to items, in drawing order. */
export const connectorEnds = (connector: NonNullable<View['connectors']>[number]) => {
  const items = connector.anchors
    .map((anchor) => anchor.ref.item)
    .filter((item): item is string => typeof item === 'string');
  return items.length >= 2 ? { from: items[0], to: items[items.length - 1] } : null;
};

export const rectangleContains = (rectangle: Rectangle, item: ViewItem) => {
  const minX = Math.min(rectangle.from.x, rectangle.to.x);
  const maxX = Math.max(rectangle.from.x, rectangle.to.x);
  const minY = Math.min(rectangle.from.y, rectangle.to.y);
  const maxY = Math.max(rectangle.from.y, rectangle.to.y);
  return item.tile.x >= minX && item.tile.x <= maxX && item.tile.y >= minY && item.tile.y <= maxY;
};

export const findView = (model: Model, viewId?: string) =>
  (viewId ? model.views.find((view) => view.id === viewId) : undefined) ?? model.views[0];

export function describeDiagram(model: Model, options: { viewId?: string } = {}): DiagramDescription {
  const view = findView(model, options.viewId);
  const pages = model.views.map((page) => ({ id: page.id, name: clip(page.name, 100) ?? 'Page' }));
  if (!view) {
    return {
      title: clip(model.title, 100) ?? 'Untitled', page: { id: '', name: '' }, pages,
      nodes: [], connections: [], groups: [], notes: [], truncated: false
    };
  }
  let truncated = false;
  const take = <T,>(list: T[], max: number) => {
    if (list.length > max) truncated = true;
    return list.slice(0, max);
  };

  const itemsById = new Map(model.items.map((item) => [item.id, item]));
  const onPage = view.items.filter((viewItem) => itemsById.has(viewItem.id));
  const nodes = take(onPage, DESCRIBE_LIMITS.nodes).map((viewItem) => {
    const item = itemsById.get(viewItem.id)!;
    const label = clip(item.label, 100);
    return {
      id: item.id,
      name: clip(item.name, 100) ?? '(unnamed)',
      ...(label && label !== clip(item.name, 100) ? { label } : {}),
      ...(iconName(model, item.icon) ? { icon: iconName(model, item.icon) } : {}),
      ...(clip(item.description) ? { description: clip(item.description) } : {})
    };
  });
  const described = new Set(nodes.map((node) => node.id));

  const connections = take((view.connectors ?? []).flatMap((connector) => {
    const ends = connectorEnds(connector);
    if (!ends || !described.has(ends.from) || !described.has(ends.to)) return [];
    const connectorName = clip(connector.name, 100);
    return [{ id: connector.id, ...ends, ...(connectorName ? { name: connectorName } : {}) }];
  }), DESCRIBE_LIMITS.connections);

  const groups = take((view.rectangles ?? []).map((rectangle) => {
    const rectangleName = clip(rectangle.name, 100);
    return {
      id: rectangle.id,
      ...(rectangleName ? { name: rectangleName } : {}),
      contains: onPage.filter((viewItem) => described.has(viewItem.id) && rectangleContains(rectangle, viewItem))
        .map((viewItem) => viewItem.id)
    };
  }), DESCRIBE_LIMITS.groups);

  const notes = take([
    ...(view.textBoxes ?? []).map((box) => ({ id: box.id, text: clip(box.content) })),
    ...(view.labels ?? []).map((label) => ({ id: label.id, text: clip(label.text) }))
  ].filter((note): note is { id: string; text: string } => !!note.text), DESCRIBE_LIMITS.notes);

  return {
    title: clip(model.title, 100) ?? 'Untitled',
    page: { id: view.id, name: clip(view.name, 100) ?? 'Page' },
    pages,
    nodes,
    connections,
    groups,
    notes,
    truncated
  };
}
