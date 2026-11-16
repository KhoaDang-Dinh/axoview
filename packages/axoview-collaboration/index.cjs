
// Stable identity for diagram entities, including nested view items. Positional
// arrays (coordinates, etc.) remain atomic; inserting an item cannot shift keys.
const entityArray = value => Array.isArray(value) && value.length > 0 &&
  value.every(v => v && typeof v === 'object' && typeof v.id === 'string') &&
  new Set(value.map(v => v.id)).size === value.length;
const entityCollections = new Set(['items', 'views', 'icons', 'colors', 'connectors', 'textBoxes', 'rectangles', 'labels', 'groups']);
const excluded = new Set(['_collab', 'name', 'folderId', 'deletedAt', 'id', 'lastModified', 'created', 'workspaceId', 'shareUuid']);
const safe = key => !['__proto__', 'prototype', 'constructor'].includes(key);

function flatten(value, path = [], result = new Map()) {
  const key = JSON.stringify(path);
  if (entityArray(value) || (Array.isArray(value) && value.length === 0 && entityCollections.has(path.at(-1)))) {
    result.set(key, { type: 'entities' });
    value.forEach((item, index) => {
      result.set(JSON.stringify([...path, item.id, '$rank']), index);
      flatten(item, [...path, item.id], result);
    });
  } else if (value && !Array.isArray(value) && typeof value === 'object') {
    result.set(key, { type: 'object' });
    for (const [name, child] of Object.entries(value)) {
      if (safe(name) && (path.length || !excluded.has(name))) flatten(child, [...path, name], result);
    }
  } else if (value !== undefined) result.set(key, { value });
  return result;
}

// Diff against the caller's previous view, not the current merged doc. Thus a
// stale render cannot erase fields which arrived from another author meanwhile.
function patchModel(doc, before, after, origin = 'local') {
  const previous = flatten(before);
  const next = flatten(after);
  const fields = doc.getMap('fields');
  doc.transact(() => {
    if (!fields.has('[]')) fields.set('[]', { type: 'object' });
    for (const key of previous.keys()) if (!next.has(key)) fields.delete(key);
    for (const [key, value] of next) {
      if (JSON.stringify(value) === JSON.stringify(previous.get(key))) continue;
      const path = JSON.parse(key);
      if (typeof value?.value === 'string' && ['name', 'title', 'description', 'content', 'label'].includes(path.at(-1))) {
        const text = doc.getText(`text:${key}`);
        const before = text.toString(), after = value.value;
        let prefix = 0, suffix = 0;
        while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
        while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
        const removed = before.length - prefix - suffix;
        if (removed) text.delete(prefix, removed);
        const inserted = after.slice(prefix, after.length - suffix);
        if (inserted) text.insert(prefix, inserted);
        if (fields.get(key)?.type !== 'text') fields.set(key, { type: 'text' });
      } else fields.set(key, value);
    }
  }, origin);
}

function readModel(doc) {
  const fields = doc.getMap('fields');
  const children = new Map();
  for (const key of fields.keys()) {
    const path = JSON.parse(key);
    if (!Array.isArray(path) || !path.every(p => typeof p === 'string' && safe(p))) throw new Error('Invalid field path');
    if (path.length) {
      const parent = JSON.stringify(path.slice(0, -1));
      if (!children.has(parent)) children.set(parent, new Set());
      children.get(parent).add(path.at(-1));
    }
  }
  const read = (path, depth = 0) => {
    if (depth > 40) throw new Error('Diagram nesting is too deep');
    const key = JSON.stringify(path), entry = fields.get(key);
    if (!entry) return undefined; // deleted entity wins over edits to its children
    if (entry.type === 'text') return doc.getText(`text:${key}`).toString();
    if (Object.hasOwn(entry, 'value')) return entry.value;
    const names = [...(children.get(key) || [])].filter(n => n !== '$rank');
    if (entry.type === 'entities') return names
      .filter(n => fields.has(JSON.stringify([...path, n])))
      .sort((a, b) => (fields.get(JSON.stringify([...path, a, '$rank'])) ?? 0) -
        (fields.get(JSON.stringify([...path, b, '$rank'])) ?? 0) || a.localeCompare(b))
      .map(n => read([...path, n], depth + 1));
    if (entry.type !== 'object') throw new Error('Invalid field');
    return Object.fromEntries(names.map(n => [n, read([...path, n], depth + 1)]).filter(([, v]) => v !== undefined));
  };
  return read([]) ?? {};
}

function seedModel(model, doc) {
  patchModel(doc, {}, model, 'seed');
  return doc;
}

exports.patchModel = patchModel;
exports.readModel = readModel;
exports.seedModel = seedModel;
