/**
 * describeDiagram for the API (the workspace MCP server's read_diagram): a
 * dependency-free copy of axoview-lib's src/agent/describe.ts, which the app
 * uses for "Include this page". One page as compact, bounded data: items by
 * name and icon, connections, which items a rectangle encloses, and the
 * page's text. No tiles, colours, styling, links or notes.
 *
 * __fixtures__/describe.contract.json is checked against both, so the two
 * cannot drift apart. Everything here is user-authored text: a caller hands
 * it to a model as untrusted data, never as instructions.
 */
export const DESCRIBE_LIMITS = Object.freeze({ nodes: 150, connections: 300, groups: 50, notes: 30, text: 200 });

const clip = (text, max = DESCRIBE_LIMITS.text) => {
  if (typeof text !== 'string' || !text) return undefined;
  const flat = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!flat) return undefined;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const list = (value) => (Array.isArray(value) ? value : []);

const iconName = (model, iconId) => {
  if (!iconId) return undefined;
  return clip(list(model.icons).find((icon) => icon?.id === iconId)?.name ?? iconId, 60);
};

const connectorEnds = (connector) => {
  const items = list(connector?.anchors).map((anchor) => anchor?.ref?.item).filter((item) => typeof item === 'string');
  return items.length >= 2 ? { from: items[0], to: items[items.length - 1] } : null;
};

const rectangleContains = (rectangle, item) => {
  const minX = Math.min(rectangle.from.x, rectangle.to.x);
  const maxX = Math.max(rectangle.from.x, rectangle.to.x);
  const minY = Math.min(rectangle.from.y, rectangle.to.y);
  const maxY = Math.max(rectangle.from.y, rectangle.to.y);
  return item.tile.x >= minX && item.tile.x <= maxX && item.tile.y >= minY && item.tile.y <= maxY;
};

export function describeDiagram(model, { viewId } = {}) {
  const views = list(model?.views);
  const view = (viewId ? views.find((candidate) => candidate?.id === viewId) : undefined) ?? views[0];
  const pages = views.map((page) => ({ id: page.id, name: clip(page.name, 100) ?? 'Page' }));
  const title = clip(model?.title, 100) ?? 'Untitled';
  if (!view) {
    return { title, page: { id: '', name: '' }, pages, nodes: [], connections: [], groups: [], notes: [], truncated: false };
  }
  let truncated = false;
  const take = (items, max) => {
    if (items.length > max) truncated = true;
    return items.slice(0, max);
  };

  const itemsById = new Map(list(model.items).map((item) => [item.id, item]));
  const onPage = list(view.items).filter((viewItem) => itemsById.has(viewItem.id) && viewItem.tile);
  const nodes = take(onPage, DESCRIBE_LIMITS.nodes).map((viewItem) => {
    const item = itemsById.get(viewItem.id);
    const name = clip(item.name, 100);
    const label = clip(item.label, 100);
    const icon = iconName(model, item.icon);
    const description = clip(item.description);
    return {
      id: item.id,
      name: name ?? '(unnamed)',
      ...(label && label !== name ? { label } : {}),
      ...(icon ? { icon } : {}),
      ...(description ? { description } : {})
    };
  });
  const described = new Set(nodes.map((node) => node.id));

  const connections = take(list(view.connectors).flatMap((connector) => {
    const ends = connectorEnds(connector);
    if (!ends || !described.has(ends.from) || !described.has(ends.to)) return [];
    const connectorName = clip(connector.name, 100);
    return [{ id: connector.id, ...ends, ...(connectorName ? { name: connectorName } : {}) }];
  }), DESCRIBE_LIMITS.connections);

  const groups = take(list(view.rectangles).filter((r) => r?.from && r?.to).map((rectangle) => {
    const rectangleName = clip(rectangle.name, 100);
    return {
      id: rectangle.id,
      ...(rectangleName ? { name: rectangleName } : {}),
      contains: onPage.filter((viewItem) => described.has(viewItem.id) && rectangleContains(rectangle, viewItem))
        .map((viewItem) => viewItem.id)
    };
  }), DESCRIBE_LIMITS.groups);

  const notes = take([
    ...list(view.textBoxes).map((box) => ({ id: box.id, text: clip(box.content) })),
    ...list(view.labels).map((label) => ({ id: label.id, text: clip(label.text) }))
  ].filter((note) => !!note.text), DESCRIBE_LIMITS.notes);

  return { title, page: { id: view.id, name: clip(view.name, 100) ?? 'Page' }, pages, nodes, connections, groups, notes, truncated };
}
