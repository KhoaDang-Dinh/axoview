/**
 * Changes waiting for approval (ADR 0059): an outside agent working as this
 * person proposed operations through the workspace MCP server. They wait for
 * this person alone (the server lists only theirs): a chip and a pop-up when
 * one arrives; the steps checked against the page as it is now; Approve makes
 * the ones that fit as one change through the editor and records how many;
 * Reject changes nothing. Someone Read only on the diagram never sees it.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) =>
      typeof fallback === 'string'
        ? fallback
        : typeof fallback === 'object' && fallback && 'defaultValue' in fallback
          ? (fallback as { defaultValue: string }).defaultValue
          : key,
    i18n: { language: 'en' }
  })
}));
const pushes: Array<{ severity: string; message: string }> = [];
jest.mock('../../stores/notificationStore', () => ({
  notificationStore: { push: (n: { severity: string; message: string }) => pushes.push(n) }
}));
const mockPlan = jest.fn();
jest.mock('axoview', () => ({
  diagramAgent: { planOperations: (...args: unknown[]) => mockPlan(...args) }
}));

import { ProposalPrompt } from '../ProposalPrompt';
import { PROPOSALS_CHANGED_EVENT } from '../../hooks/useRealtimeSync';
import { useAssistantPageStore } from '../../stores/assistantPageStore';
import type { DiagramRole, Proposal, ProposalDecision } from '../../services/storage/types';

const OPS = [{ op: 'add_node', name: 'Cache' }, { op: 'connect', from: { name: 'Web' }, to: { name: 'Cache' } }];
const proposal = (id: string, operations: unknown[] = OPS): Proposal => ({
  id,
  by: { sub: 'me', agent: 'Claude Code' },
  viewId: 'p1',
  operations,
  note: 'Add a cache in front of the database',
  createdAt: '2026-11-10T07:00:00.000Z'
});
const step = (index: number, summary: string, status = 'ready', problem?: string) =>
  ({ index, status, summary, howTo: '', manualSection: '', nodeIds: [], ...(problem ? { problem } : {}) });
const page = { model: { title: 'D' }, viewId: 'p1' };

function storage(waiting: Proposal[][], decide?: () => ProposalDecision) {
  let call = 0;
  return {
    listProposals: jest.fn(async () => waiting[Math.min(call++, waiting.length - 1)]),
    resolveProposal: jest.fn(async (): Promise<ProposalDecision> => (decide ? decide() : { ok: true }))
  };
}

const chip = () => document.querySelector('[data-axoview-id="proposals-chip"]');
const button = (id: string) => document.querySelector(`[data-axoview-id="${id}"]`) as HTMLButtonElement;

async function show(role: DiagramRole | undefined, s: ReturnType<typeof storage>) {
  await act(async () => { render(<ProposalPrompt diagramId="d1" role={role} storage={s} />); });
}

let applyToPage: jest.Mock;
beforeEach(() => {
  pushes.length = 0;
  mockPlan.mockReset();
  mockPlan.mockReturnValue([step(0, 'Add “Cache”'), step(1, 'Connect “Web” to “Cache”')]);
  applyToPage = jest.fn((ops: unknown[]) => ops.map((_, k) => step(k, 'done')));
  useAssistantPageStore.setState({ readPage: () => page as never, applyToPage: applyToPage as never, canChangePage: () => true });
});

it('a person who may change the diagram sees a chip and a pop-up for waiting changes', async () => {
  await show('owner', storage([[proposal('p1')]]));
  expect(chip()?.textContent).toBe('1 to approve');
  expect(pushes).toEqual([{ severity: 'info', message: 'A change to this diagram is waiting for your approval' }]);
});

it('a Read only person never sees it, nor asks, even when the stream announces one', async () => {
  const s = storage([[proposal('p1')]]);
  await show('viewer', s);
  await act(async () => { window.dispatchEvent(new CustomEvent(PROPOSALS_CHANGED_EVENT, { detail: { id: 'd1' } })); });
  expect(chip()).toBeNull();
  expect(s.listProposals).not.toHaveBeenCalled();
});

it('shows who, their note and the steps checked against the page now', async () => {
  await show('owner', storage([[proposal('p1')]]));
  await act(async () => { fireEvent.click(chip()!); });
  expect(mockPlan).toHaveBeenCalledWith(page.model, 'p1', OPS);
  const shown = document.querySelector('[data-axoview-id="proposal"]')!;
  expect(shown.textContent).toContain('From Claude Code, ' + new Date('2026-11-10T07:00:00.000Z').toLocaleString());
  expect(screen.getByText('Add a cache in front of the database')).toBeTruthy();
  expect(Array.from(document.querySelectorAll('[data-axoview-id="proposal-step"]')).map((el) => el.textContent))
    .toEqual(['Add “Cache”', 'Connect “Web” to “Cache”']);
});

it('approve: both steps made as one change, the decision recorded with the count, the chip goes', async () => {
  const s = storage([[proposal('p1')]]);
  await show('admin', s);
  await act(async () => { fireEvent.click(chip()!); });
  await act(async () => { fireEvent.click(button('proposal-approve')); });
  expect(applyToPage).toHaveBeenCalledTimes(1);
  expect(applyToPage).toHaveBeenCalledWith(OPS, 'p1');
  expect(s.resolveProposal).toHaveBeenCalledWith('d1', 'p1', 'approve', 2);
  expect(pushes.at(-1)).toEqual({ severity: 'success', message: '2 changes approved and made' });
  expect(chip()).toBeNull();
});

it('a step that no longer fits is shown with why, and only the rest is made', async () => {
  mockPlan.mockReturnValue([step(0, 'Add “Cache”'), step(1, 'Remove “FTP”', 'not_applicable', 'No item named “FTP”')]);
  const s = storage([[proposal('p1')]]);
  await show('owner', s);
  await act(async () => { fireEvent.click(chip()!); });
  expect(screen.getByText('Not applicable: No item named “FTP”')).toBeTruthy();
  expect(button('proposal-approve').textContent).toBe('Approve the 1 that fit');
  await act(async () => { fireEvent.click(button('proposal-approve')); });
  expect(applyToPage).toHaveBeenCalledWith([OPS[0]], 'p1');
  expect(s.resolveProposal).toHaveBeenCalledWith('d1', 'p1', 'approve', 1);
});

it('nothing fits any more: Approve is off; Reject records it and changes nothing', async () => {
  mockPlan.mockReturnValue([step(0, 'Remove “FTP”', 'not_applicable', 'gone')]);
  const s = storage([[proposal('p1')]]);
  await show('owner', s);
  await act(async () => { fireEvent.click(chip()!); });
  expect(button('proposal-approve').disabled).toBe(true);
  await act(async () => { fireEvent.click(button('proposal-reject')); });
  expect(s.resolveProposal).toHaveBeenCalledWith('d1', 'p1', 'reject', undefined);
  expect(applyToPage).not.toHaveBeenCalled();
  expect(pushes.at(-1)).toEqual({ severity: 'success', message: 'Change rejected' });
});

it('on a read-only view nothing is made', async () => {
  useAssistantPageStore.setState({ canChangePage: () => false });
  const s = storage([[proposal('p1')]]);
  await show('owner', s);
  await act(async () => { fireEvent.click(chip()!); });
  await act(async () => { fireEvent.click(button('proposal-approve')); });
  expect(applyToPage).not.toHaveBeenCalled();
  expect(s.resolveProposal).not.toHaveBeenCalled();
  expect(pushes.at(-1)?.severity).toBe('error');
});

it('a new proposal on the sync stream refreshes the list, announced once', async () => {
  const s = storage([[proposal('p1')], [proposal('p1'), proposal('p2')]]);
  await show('owner', s);
  expect(pushes).toHaveLength(1);
  await act(async () => { window.dispatchEvent(new CustomEvent(PROPOSALS_CHANGED_EVENT, { detail: { id: 'other' } })); });
  expect(s.listProposals).toHaveBeenCalledTimes(1);
  await act(async () => { window.dispatchEvent(new CustomEvent(PROPOSALS_CHANGED_EVENT, { detail: { id: 'd1' } })); });
  expect(chip()?.textContent).toBe('2 to approve');
  expect(pushes).toHaveLength(2);
});

it('their own diagram, never shared (no role): checks when it opens', async () => {
  const s = storage([[proposal('p1')]]);
  await show(undefined, s);
  expect(s.listProposals).toHaveBeenCalledTimes(1);
  expect(chip()?.textContent).toBe('1 to approve');
});
