/**
 * Diagram suggestions: the page description the app may send with a message,
 * and the operations the model may recommend back (ADR 0052 addendum
 * 2026-11-04).
 *
 * The operation vocabulary is defined in axoview-lib
 * (src/agent/operations.ts, diagramOperationSchema); this is the API's
 * dependency-free copy of its shape rules. __fixtures__/suggestions.contract.json
 * is checked against both, so they cannot drift apart.
 *
 * Nothing here changes a diagram. The app checks each suggestion against the
 * live page (planOperations) and shows it as a checklist the user carries out.
 */
export const MAX_SUGGESTIONS = 8;
const MAX_OPERATIONS = 12;

const OPERATIONS = {
  add_node: { name: 'name', icon: 'icon?', near: 'ref?' },
  rename_node: { node: 'ref', name: 'name' },
  set_notes: { node: 'ref', notes: 'text' },
  remove_node: { node: 'ref' },
  connect: { from: 'ref', to: 'ref', label: 'label?' },
  disconnect: { from: 'ref', to: 'ref' },
  group: { nodes: 'refs', name: 'name' },
  add_note: { text: 'text', near: 'ref?' }
};
const LIMITS = { name: 100, icon: 100, label: 100, text: 1000, reason: 300 };

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const string = (value, max) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= max ? trimmed : null;
};

const nodeRef = (value) => {
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 1) return null;
  if (keys[0] === 'id') {
    return typeof value.id === 'string' && value.id.length >= 1 && value.id.length <= 100 ? { id: value.id } : null;
  }
  if (keys[0] === 'name') {
    const name = string(value.name, LIMITS.name);
    return name ? { name } : null;
  }
  return null;
};

/** A normalised copy of one operation (strings trimmed), or null when it is not valid. */
export function validateSuggestion(value) {
  if (!isPlainObject(value) || typeof value.op !== 'string' || !Object.hasOwn(OPERATIONS, value.op)) return null;
  const fields = OPERATIONS[value.op];
  const out = { op: value.op };
  for (const key of Object.keys(value)) {
    if (key !== 'op' && key !== 'reason' && !Object.hasOwn(fields, key)) return null;
  }
  for (const [key, kind] of Object.entries(fields)) {
    const optional = kind.endsWith('?');
    const type = optional ? kind.slice(0, -1) : kind;
    if (value[key] === undefined) {
      if (optional) continue;
      return null;
    }
    let parsed;
    if (type === 'ref') parsed = nodeRef(value[key]);
    else if (type === 'refs') {
      const list = Array.isArray(value[key]) && value[key].length >= 1 && value[key].length <= 50
        ? value[key].map(nodeRef) : null;
      parsed = list && list.every(Boolean) ? list : null;
    } else parsed = string(value[key], LIMITS[type]);
    if (parsed === null) return null;
    out[key] = parsed;
  }
  if (value.reason !== undefined) {
    if (typeof value.reason !== 'string') return null;
    const reason = value.reason.trim();
    if (reason.length > LIMITS.reason) return null;
    if (reason) out.reason = reason;
  }
  return out;
}

const BLOCK_RE = /```suggestions[ \t]*\n([\s\S]*?)```/g;

/**
 * Splits a model reply into the text shown to the user and the suggestions in
 * its ```suggestions block(s). Malformed JSON or operations are dropped, not
 * repaired; the reply text never contains the block.
 */
export function extractSuggestions(text) {
  const suggestions = [];
  let dropped = 0;
  for (const match of text.matchAll(BLOCK_RE)) {
    let parsed;
    try {
      parsed = JSON.parse(match[1]);
    } catch {
      dropped++;
      continue;
    }
    for (const candidate of (Array.isArray(parsed) ? parsed : [parsed]).slice(0, MAX_OPERATIONS)) {
      const valid = validateSuggestion(candidate);
      if (valid && suggestions.length < MAX_SUGGESTIONS) suggestions.push(valid);
      else dropped++;
    }
  }
  const reply = text.replace(BLOCK_RE, '').replace(/\n{3,}/g, '\n\n').trim();
  return { reply, suggestions, dropped };
}

// --- The page description (axoview-lib describeDiagram) ----------------------

export const DIAGRAM_CONTEXT_MAX_BYTES = 24_000;
const PAGE_LIMITS = { nodes: 150, connections: 300, groups: 50, notes: 30, pages: 5 };

const responseError = (status, message) => Object.assign(new Error(message), { status });
const id = (value) => (typeof value === 'string' && /^[\w:.-]{1,100}$/.test(value) ? value : null);
const text = (value, max = 200) => (typeof value === 'string' && value.length <= max ? value : undefined);

/**
 * Checks the page description the app sent and keeps only the fields the
 * prompt uses. Rejects (400) anything oversized or malformed rather than
 * trimming it, so a client cannot smuggle extra data past the limits.
 */
export function validateDiagramContext(value) {
  const invalid = () => responseError(400, 'Invalid diagram context');
  if (!isPlainObject(value)) throw invalid();
  if (JSON.stringify(value).length > DIAGRAM_CONTEXT_MAX_BYTES) throw responseError(413, 'Diagram context is too large');
  const list = (key, max) => {
    const entries = value[key] ?? [];
    if (!Array.isArray(entries) || entries.length > max) throw invalid();
    return entries;
  };
  const page = isPlainObject(value.page) ? { id: id(value.page.id), name: text(value.page.name, 100) } : null;
  if (!page?.id) throw invalid();

  const nodes = list('nodes', PAGE_LIMITS.nodes).map((node) => {
    if (!isPlainObject(node) || !id(node.id) || typeof node.name !== 'string') throw invalid();
    return {
      id: node.id,
      name: text(node.name, 100) ?? '(unnamed)',
      ...(text(node.label, 100) ? { label: node.label } : {}),
      ...(text(node.icon, 60) ? { icon: node.icon } : {}),
      ...(text(node.description) ? { description: node.description } : {})
    };
  });
  const known = new Set(nodes.map((node) => node.id));
  const connections = list('connections', PAGE_LIMITS.connections).flatMap((connection) => {
    if (!isPlainObject(connection) || !id(connection.from) || !id(connection.to)) throw invalid();
    if (!known.has(connection.from) || !known.has(connection.to)) return [];
    return [{ from: connection.from, to: connection.to, ...(text(connection.name, 100) ? { name: connection.name } : {}) }];
  });
  const groups = list('groups', PAGE_LIMITS.groups).map((group) => {
    if (!isPlainObject(group) || !Array.isArray(group.contains)) throw invalid();
    return {
      ...(text(group.name, 100) ? { name: group.name } : {}),
      contains: group.contains.filter((member) => known.has(member)).slice(0, PAGE_LIMITS.nodes)
    };
  });
  const notes = list('notes', PAGE_LIMITS.notes).flatMap((note) => {
    if (!isPlainObject(note)) throw invalid();
    return text(note.text) ? [note.text] : [];
  });
  const pages = list('pages', PAGE_LIMITS.pages).flatMap((entry) =>
    (isPlainObject(entry) && text(entry.name, 100) ? [entry.name] : []));

  return {
    title: text(value.title, 100) ?? 'Untitled',
    page: { id: page.id, name: page.name ?? 'Page' },
    pages,
    nodes,
    connections,
    groups,
    notes,
    truncated: value.truncated === true
  };
}

/** The validated page as compact lines for the prompt; ids let the model refer to items exactly. */
export function composeDiagramContext(diagram) {
  const q = (value) => JSON.stringify(value);
  const lines = [
    `Diagram ${q(diagram.title)}, page ${q(diagram.page.name)}` +
      (diagram.pages.length > 1 ? ` (pages: ${diagram.pages.map(q).join(', ')})` : '') + '.',
    `Items (${diagram.nodes.length}):`,
    ...diagram.nodes.map((node) => `- [${node.id}] ${q(node.name)}` +
      (node.label ? ` shown as ${q(node.label)}` : '') +
      (node.icon ? `, icon ${q(node.icon)}` : '') +
      (node.description ? `: ${q(node.description)}` : '')),
    `Connections (${diagram.connections.length}):`,
    ...diagram.connections.map((c) => `- ${c.from} -> ${c.to}${c.name ? ` ${q(c.name)}` : ''}`),
    ...(diagram.groups.length ? [
      'Rectangles:',
      ...diagram.groups.map((group) => `- ${group.name ? q(group.name) : '(unnamed)'} around ${group.contains.join(', ') || 'nothing'}`)
    ] : []),
    ...(diagram.notes.length ? ['Text on the page:', ...diagram.notes.map((note) => `- ${q(note)}`)] : []),
    ...(diagram.truncated ? ['(The page is larger than this description; some items were left out.)'] : [])
  ];
  return lines.join('\n');
}
