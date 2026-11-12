/**
 * Carry out an AI agent's operations on the open diagram, once its person has
 * approved them (ADR 0052 addendum 2026-11-10, ADR 0057 addendum 3).
 *
 * The operations go through the same applyOperations the recommendations were
 * checked with (src/agent), on the live model, and land as ONE undoable change:
 * a single Ctrl+Z takes the whole approval back. The scene for the page on
 * screen is rebuilt from the new model, so new connectors are routed at once.
 *
 * Only `ready` steps change anything; the steps are returned so the caller can
 * say what was done and what was not.
 *
 * Two ways in. `apply` does it at once (the in-app assistant: approved in the
 * chat, saved like any edit). `prepare` works the change out WITHOUT touching
 * the editor and hands back the resulting diagram, so a host can store it
 * first and put it on screen (`commit`) only once it is stored (approving an
 * outside agent's proposal: ADR 0059 addendum 2026-11-12). What `commit` puts
 * in the editor is the very diagram `prepare` returned, new ids included; if
 * the diagram was edited in between, the steps are made again on it as it is
 * now, so that edit is kept.
 */
import { useCallback, useMemo } from 'react';
import { useModelStoreApi } from 'src/stores/modelStore';
import { useSceneStoreApi } from 'src/stores/sceneStore';
import { useUiStateStoreApi } from 'src/stores/uiStateStore';
import * as reducers from 'src/stores/reducers';
import { INITIAL_SCENE_STATE } from 'src/config';
import { allocateHistorySequence } from 'src/stores/historySequence';
import { modelFromModelStore } from 'src/utils/model';
import type { Icon, Model } from 'src/types';
import { applyOperations, type PlanStep } from 'src/agent';

/** A change worked out by `prepare`, not yet in the editor. */
export interface PreparedAgentChange {
  /** What each operation would do; only `ready` ones change anything. */
  steps: PlanStep[];
  /** The diagram with the ready steps made. */
  model: Model;
  /** Put it in the editor as one undoable change; returns the steps as made. */
  commit: () => PlanStep[];
}

const norm = (text: string) => text.trim().toLowerCase();

/**
 * The icon an add_node's hint names: an exact id or name first, then the
 * first icon whose name contains the hint. Undefined leaves the item plain.
 */
export function iconForHint(icons: Icon[], hint: string | undefined): string | undefined {
  if (!hint || !norm(hint)) return undefined;
  const wanted = norm(hint);
  const exact = icons.find((icon) => norm(icon.id) === wanted || norm(icon.name) === wanted);
  if (exact) return exact.id;
  return icons.find((icon) => norm(icon.name).includes(wanted))?.id;
}

export function useAgentChanges() {
  const modelStore = useModelStoreApi();
  const sceneStore = useSceneStoreApi();
  const uiStore = useUiStateStoreApi();

  /** Replace the diagram with `next` as one undoable change stamped with `target`. */
  const put = useCallback((next: Model, target: string | undefined) => {
    // One logical action across both stores (the same bracket useSceneActions
    // uses), stamped with the page it changed so undo returns to it.
    allocateHistorySequence(target);
    const model = modelStore.getState().actions;
    const scene = sceneStore.getState().actions;
    model.clearFuture();
    scene.clearFuture();
    model.saveToHistory();
    scene.saveToHistory();

    const onScreen = uiStore.getState().view || undefined;
    const sceneView = next.views.some((view) => view.id === onScreen) ? onScreen : next.views[0].id;
    const synced = reducers.view({
      action: 'SYNC_SCENE',
      payload: undefined,
      ctx: { viewId: sceneView!, state: { model: next, scene: INITIAL_SCENE_STATE } }
    });
    model.set(next, true);
    scene.set(synced.scene, true);
  }, [modelStore, sceneStore, uiStore]);

  const prepare = useCallback((operations: unknown[], viewId?: string): PreparedAgentChange | null => {
    const before = modelFromModelStore(modelStore.getState() as never);
    if (before.views.length === 0) return null;
    const target = viewId ?? (uiStore.getState().view || undefined);
    const { model: next, steps } = applyOperations(before, target, operations, {
      iconFor: (hint) => iconForHint(before.icons, hint)
    });
    const commit = (): PlanStep[] => {
      const now = modelFromModelStore(modelStore.getState() as never);
      const edited = (Object.keys(before) as (keyof Model)[]).some((key) => now[key] !== before[key]);
      // Edited since it was prepared: make the steps on the diagram as it is now.
      if (edited) return prepare(operations, viewId)?.commit() ?? [];
      if (steps.some((step) => step.status === 'ready')) put(next, target);
      return steps;
    };
    return { steps, model: next, commit };
  }, [modelStore, uiStore, put]);

  const apply = useCallback(
    (operations: unknown[], viewId?: string): PlanStep[] => prepare(operations, viewId)?.commit() ?? [],
    [prepare]
  );

  return useMemo(() => ({ apply, prepare }), [apply, prepare]);
}

/** `apply` alone: carry the operations out at once. */
export function useAgentCommit() {
  return useAgentChanges().apply;
}
