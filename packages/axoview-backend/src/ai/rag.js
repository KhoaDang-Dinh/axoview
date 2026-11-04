/**
 * Stage-2 public-only RAG boundary. No private diagram search or embedding
 * index is reachable here. Curated versioned public help snippets are retrieved
 * locally so no separate paid vector infrastructure is required initially.
 * This is a modest lexical RAG baseline, NOT the private workspace RAG stage.
 */
export const PUBLIC_KNOWLEDGE = Object.freeze([
  { id: 'overview', title: 'What is Axoview', text: 'Axoview is a visual diagram editor for architecture and technical systems. Users organize diagrams into a workspace and can export them.' },
  { id: 'sharing', title: 'Publishing a diagram', text: 'A published view-only link exposes only the saved public snapshot. Publishing does not grant permission to edit or browse the owner workspace. Removing the share invalidates the published link.' },
  { id: 'storage', title: 'Diagram storage', text: 'Authenticated Axoview workspaces save diagrams through the backend. The service uses object storage for diagram content and metadata storage for the workspace index.' },
  { id: 'export', title: 'Import and export', text: 'Axoview can export project diagrams as a ZIP archive and import a project ZIP or a single diagram JSON file.' }
]);

const STOP_WORDS = new Set(['the','and','for','what','how','where','with','from','can','are','does','this','that','you','your','into','about']);
const terms = (text) => new Set((text.toLowerCase().match(/[a-z0-9]{3,}/g) || [])
  .filter((token) => !STOP_WORDS.has(token)));
export function retrievePublicKnowledge(query, { limit = 3, corpus = PUBLIC_KNOWLEDGE } = {}) {
  const words = terms(query);
  if (words.size === 0) return [];
  return corpus.map((item) => {
    const docWords = terms(item.title + ' ' + item.text);
    let score = 0;
    for (const word of words) if (docWords.has(word)) score++;
    return { ...item, score };
  })
    .filter((item) => item.score > 0 && /^[a-z0-9_-]+$/.test(item.id))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, Math.min(3, Math.max(0, limit)))
    .map(({ id, title, text }) => ({ id, title, text: text.slice(0, 900) }));
}
export function composeRagContext(items) {
  return items.map((item) => `[source:${item.id}] ${item.title}\n${item.text}`).join('\n\n').slice(0, 3500);
}
