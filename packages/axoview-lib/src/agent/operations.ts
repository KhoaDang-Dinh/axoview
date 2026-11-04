/**
 * The diagram operation vocabulary an AI agent may propose (ADR 0052
 * addendum 2026-11-04). It is deliberately small and semantic: an operation
 * names items the way a person does ("connect Web to Database"), never tiles,
 * anchors or colours, so a model can produce it from a page description and a
 * person can check it at a glance.
 *
 * Today the assistant only RECOMMENDS: planOperations checks each operation
 * against the live page and the user carries it out. applyOperations is the
 * write primitive for the later approve-and-apply stage and is not wired to any
 * UI or API.
 */
import * as z from 'zod';

export const MAX_OPERATIONS = 12;

const name = z.string().trim().min(1).max(100);
const reason = z.string().trim().max(300).optional();

/** An item on the page, by id (from describeDiagram) or by its name or label. */
export const nodeRefSchema = z.union([
  z.object({ id: z.string().min(1).max(100) }).strict(),
  z.object({ name }).strict()
]);

export const diagramOperationSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('add_node'),
    name,
    icon: z.string().trim().min(1).max(100).optional(),
    near: nodeRefSchema.optional(),
    reason
  }).strict(),
  z.object({ op: z.literal('rename_node'), node: nodeRefSchema, name, reason }).strict(),
  z.object({
    op: z.literal('set_notes'),
    node: nodeRefSchema,
    notes: z.string().trim().min(1).max(1000),
    reason
  }).strict(),
  z.object({ op: z.literal('remove_node'), node: nodeRefSchema, reason }).strict(),
  z.object({
    op: z.literal('connect'),
    from: nodeRefSchema,
    to: nodeRefSchema,
    label: z.string().trim().min(1).max(100).optional(),
    reason
  }).strict(),
  z.object({ op: z.literal('disconnect'), from: nodeRefSchema, to: nodeRefSchema, reason }).strict(),
  z.object({
    op: z.literal('group'),
    nodes: z.array(nodeRefSchema).min(1).max(50),
    name,
    reason
  }).strict(),
  z.object({
    op: z.literal('add_note'),
    text: z.string().trim().min(1).max(1000),
    near: nodeRefSchema.optional(),
    reason
  }).strict()
]);

export const diagramOperationsSchema = z.array(diagramOperationSchema).max(MAX_OPERATIONS);

export type NodeRef = z.infer<typeof nodeRefSchema>;
export type DiagramOperation = z.infer<typeof diagramOperationSchema>;
export type DiagramOperationKind = DiagramOperation['op'];

export const OPERATION_KINDS = diagramOperationSchema.options.map(
  (option) => option.shape.op.value
) as DiagramOperationKind[];
