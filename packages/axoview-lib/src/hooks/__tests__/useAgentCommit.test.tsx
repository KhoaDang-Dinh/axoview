/**
 * An agent's approved operations land on the live diagram as ONE undoable
 * change (ADR 0052 addendum 2026-11-10): one undo takes the whole approval
 * back, new connectors are routed at once, and nothing happens when no step
 * applies.
 */
import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { ModelProvider, useModelStoreApi } from '../../stores/modelStore';
import { SceneProvider, useSceneStoreApi } from '../../stores/sceneStore';
import { UiStateProvider, useUiStateStoreApi } from '../../stores/uiStateStore';
import { useHistory } from '../useHistory';
import { iconForHint, useAgentCommit } from '../useAgentCommit';

const AllProviders = ({ children }: { children: React.ReactNode }) => (
  <ModelProvider>
    <SceneProvider>
      <UiStateProvider>{children}</UiStateProvider>
    </SceneProvider>
  </ModelProvider>
);

const ICONS = [
  { id: 'server', name: 'Server', url: 'x' },
  { id: 'db', name: 'Database', url: 'x' }
];

function setup() {
  const hook = renderHook(() => ({
    commit: useAgentCommit(),
    history: useHistory(),
    model: useModelStoreApi(),
    scene: useSceneStoreApi(),
    ui: useUiStateStoreApi()
  }), { wrapper: AllProviders });
  act(() => {
    hook.result.current.model.getState().actions.set({
      title: 'T',
      colors: [{ id: 'c1', value: '#000000' }],
      icons: ICONS,
      items: [{ id: 'web', name: 'Web', icon: 'server' }],
      views: [{ id: 'p1', name: 'Page 1', items: [{ id: 'web', tile: { x: 0, y: 0 } }], connectors: [] }]
    }, true);
    hook.result.current.ui.getState().actions.setView('p1');
  });
  return hook;
}

it('applies the ready steps as one undoable change, routing the new connector', () => {
  const { result } = setup();
  let steps: ReturnType<typeof result.current.commit> = [];
  act(() => {
    steps = result.current.commit([
      { op: 'add_node', name: 'Cache', icon: 'database' },
      { op: 'connect', from: { name: 'Web' }, to: { name: 'Cache' } },
      { op: 'rename_node', node: { name: 'Nobody' }, name: 'X' }
    ], 'p1');
  });
  expect(steps.map((s) => s.status)).toEqual(['ready', 'ready', 'not_applicable']);
  const model = result.current.model.getState();
  const cache = model.items.find((item) => item.name === 'Cache');
  expect(cache?.icon).toBe('db');
  const connector = model.views[0].connectors![0];
  expect(Object.keys(result.current.scene.getState().connectors)).toEqual([connector.id]);

  act(() => { result.current.history.undo(); });
  expect(result.current.model.getState().items.map((item) => item.name)).toEqual(['Web']);
  expect(result.current.model.getState().views[0].connectors).toEqual([]);
  expect(result.current.model.getState().actions.canUndo()).toBe(false);
});

it('nothing applicable: no change and no history entry', () => {
  const { result } = setup();
  let steps: ReturnType<typeof result.current.commit> = [];
  act(() => { steps = result.current.commit([{ op: 'remove_node', node: { name: 'Nobody' } }], 'p1'); });
  expect(steps[0].status).toBe('not_applicable');
  expect(result.current.model.getState().actions.canUndo()).toBe(false);
});

it('matches an icon hint by id or name, exact before partial', () => {
  expect(iconForHint(ICONS, 'Server')).toBe('server');
  expect(iconForHint(ICONS, 'data')).toBe('db');
  expect(iconForHint(ICONS, 'printer')).toBeUndefined();
  expect(iconForHint(ICONS, undefined)).toBeUndefined();
});
