import type { Doc } from 'yjs';
export function patchModel(doc: Doc, before: unknown, after: unknown, origin?: unknown): void;
export function readModel(doc: Doc): Record<string, unknown>;
export function seedModel(model: unknown, doc: Doc): Doc;
