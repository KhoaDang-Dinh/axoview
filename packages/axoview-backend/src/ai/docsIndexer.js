/**
 * Keeps the public docs vector index in step with the shipped manual corpus.
 * Incremental and idempotent: only sections whose content hash changed are
 * re-embedded, sections that left the manual are deleted, and a second run
 * with the same corpus does nothing (no embedding cost).
 *
 * Run by the docs-index PostSync Job (infra deploy/k8s/base/docs-index.yaml)
 * through src/cli/index-manual.js, with a role that may write the index; the
 * API itself only queries it.
 */

/** What is embedded for a section: its title (the task) and its text. */
export const documentText = (chunk) => `${chunk.title}\n${chunk.text}`;

export async function syncManualIndex({ chunks, embed, index }) {
  const wanted = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  const existing = new Map((await index.list()).map((vector) => [vector.key, vector.metadata || {}]));

  const changed = chunks.filter((chunk) => {
    const meta = existing.get(chunk.id);
    return !meta || meta.hash !== chunk.hash || meta.audience !== chunk.audience;
  });
  const removed = [...existing.keys()].filter((key) => !wanted.has(key));

  if (changed.length) {
    const vectors = await embed(changed.map(documentText), 'search_document');
    await index.put(changed.map((chunk, i) => ({
      key: chunk.id,
      data: vectors[i],
      metadata: { audience: chunk.audience, hash: chunk.hash }
    })));
  }
  if (removed.length) await index.delete(removed);

  return {
    added: changed.filter((chunk) => !existing.has(chunk.id)).length,
    updated: changed.filter((chunk) => existing.has(chunk.id)).length,
    removed: removed.length,
    unchanged: chunks.length - changed.length
  };
}
