/**
 * Diagram primitives for AI agents (ADR 0052 addendum 2026-11-04): describe a
 * page, check proposed operations against it, and apply the ones a person
 * approved (through the editor: hooks/useAgentCommit.ts).
 * Pure and DOM-free, so they ship in the Node-safe standalone bundle.
 */
export {
  MAX_OPERATIONS, OPERATION_KINDS, diagramOperationSchema, diagramOperationsSchema, nodeRefSchema
} from './operations';
export type { DiagramOperation, DiagramOperationKind, NodeRef } from './operations';
export { describeDiagram, DESCRIBE_LIMITS } from './describe';
export type { DiagramDescription } from './describe';
export { planOperations } from './plan';
export type { PlanStep, StepStatus } from './plan';
export { applyOperations } from './apply';
export type { ApplyOptions, ApplyResult } from './apply';
