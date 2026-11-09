/**
 * The page tabs expose which page is on screen (role="tab", aria-selected):
 * screen readers announce it, and browser tests read it without the store.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

const mockSwitchView = jest.fn();
let mockCurrentView = 'p2';
const mockViews = [
  { id: 'p1', name: 'Overview', items: [] },
  { id: 'p2', name: 'Details', items: [] }
];
jest.mock('src/stores/modelStore', () => ({
  useModelStore: (selector: (s: unknown) => unknown) =>
    selector({ views: mockViews, title: 'Two pages', actions: { set: jest.fn() } })
}));
jest.mock('src/stores/uiStateStore', () => ({
  useUiStateStore: (selector: (s: unknown) => unknown) =>
    selector({ view: mockCurrentView, editorMode: 'EDITABLE', actions: {} })
}));
jest.mock('src/hooks/useScene', () => ({
  useScene: () => ({ createView: jest.fn(), deleteView: jest.fn(), updateView: jest.fn(), switchView: mockSwitchView })
}));
jest.mock('src/stores/localeStore', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

import { ViewTabs } from '../ViewTabs';

beforeEach(() => { mockSwitchView.mockClear(); mockCurrentView = 'p2'; });

it('lists the pages as tabs and marks the one on screen', () => {
  render(<ViewTabs />);
  expect(screen.getByRole('tablist', { name: 'Pages' })).toBeTruthy();
  const tabs = screen.getAllByRole('tab');
  expect(tabs.map((t) => [t.textContent, t.getAttribute('aria-selected'), t.getAttribute('data-view-id')])).toEqual([
    ['Overview', 'false', 'p1'],
    ['Details', 'true', 'p2']
  ]);
});

it('clicking a tab asks for that page', () => {
  render(<ViewTabs />);
  fireEvent.click(screen.getAllByRole('tab')[0]);
  expect(mockSwitchView).toHaveBeenCalledWith('p1');
});
