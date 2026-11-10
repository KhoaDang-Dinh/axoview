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
 */
import { useCallback } from 'react';
import { useModelStoreApi } from 'src/stores/modelStore';
import { useSceneStoreApi } from 'src/stores/sceneStore';
import { useUiStateStoreApi } from 'src/stores/uiStateStore';
import * as reducers from 'src/stores/reducers';
import { INITIAL_SCENE_STATE } from 'src/config';
import { allocateHistorySequence } from 'src/stores/historySequence';
import { modelFromModelStore } from 'src/utils/model';
import type { Icon } from 'src/types';
import { applyOperations, type PlanStep } from 'src/agent';

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

export function useAgentCommit() {
  const modelStore = useModelStoreApi();
  const sceneStore = useSceneStoreApi();
  const uiStore = useUiStateStoreApi();

  return useCallback((operations: unknown[], viewId?: string): PlanStep[] => {
    const before = modelFromModelStore(modelStore.getState() as never);
    if (before.views.length === 0) return [];
    const onScreen = uiStore.getState().view || undefined;
    const target = viewId ?? onScreen;
    const { model: next, steps } = applyOperations(before, target, operations, {
      iconFor: (hint) => iconForHint(before.icons, hint)
    });
    if (!steps.some((step) => step.status === 'ready')) return steps;

    // One logical action across both stores (the same bracket useSceneActions
    // uses), stamped with the page it changed so undo returns to it.
    allocateHistorySequence(target);
    const model = modelStore.getState().actions;
    const scene = sceneStore.getState().actions;
    model.clearFuture();
    scene.clearFuture();
    model.saveToHistory();
    scene.saveToHistory();

    const sceneView = next.views.some((view) => view.id === onScreen) ? onScreen : next.views[0].id;
    const synced = reducers.view({
      action: 'SYNC_SCENE',
      payload: undefined,
      ctx: { viewId: sceneView!, state: { model: next, scene: INITIAL_SCENE_STATE } }
    });
    model.set(next, true);
    scene.set(synced.scene, true);
    return steps;
  }, [modelStore, sceneStore, uiStore]);
}
