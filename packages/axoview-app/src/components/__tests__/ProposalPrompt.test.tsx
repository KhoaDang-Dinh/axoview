/**
 * Changes waiting for approval (ADR 0059): an outside agent working as this
 * person proposed operations through the workspace MCP server. They wait for
 * this person alone (the server lists only theirs): a chip and a pop-up when
 * one arrives; the steps checked against the page as it is now. Approve
 * stores the diagram with the steps that fit and only then shows them (ADR
 * 0059 addendum 2026-11-12): when storing fails nothing changes and the
 * proposal keeps waiting. Reject changes nothing. Someone Read only on the
 * diagram never sees it.
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
    approveProposal: jest.fn(async (): Promise<ProposalDecision> => (decide ? decide() : { ok: true })),
    rejectProposal: jest.fn(async (): Promise<ProposalDecision> => (decide ? decide() : { ok: true }))
  };
}

const chip = () => document.querySelector('[data-axoview-id="proposals-chip"]');
const button = (id: string) => document.querySelector(`[data-axoview-id="${id}"]`) as HTMLButtonElement;

async function show(role: DiagramRole | undefined, s: ReturnType<typeof storage>) {
  await act(async () => { render(<ProposalPrompt diagramId="d1" role={role} storage={s} />); });
}

// The editor's side (DiagramLifecycleProvider): works the change out, hands
// the resulting document to `store`, and shows it only if that says yes.
const DOCUMENT = { title: 'D', items: ['with the steps made'] };
let shown: unknown[][];
let storeThenApply: jest.Mock;
beforeEach(() => {
  pushes.length = 0;
  shown = [];
  mockPlan.mockReset();
  mockPlan.mockReturnValue([step(0, 'Add “Cache”'), step(1, 'Connect “Web” to “Cache”')]);
  storeThenApply = jest.fn(async (ops: unknown[], _viewId: string | undefined, store: (document: unknown, made: number) => Promise<boolean>) => {
    const steps = ops.map((_, k) => step(k, 'done'));
    if (!(await store(DOCUMENT, ops.length))) return { status: 'not-stored', steps };
    shown.push(ops);
    return { status: 'made', steps };
  });
  useAssistantPageStore.setState({ readPage: () => page as never, storeThenApplyToPage: storeThenApply as never, canChangePage: () => true });
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

it('approve: the diagram with both steps is stored, then they show, and the chip goes', async () => {
  const s = storage([[proposal('p1')]]);
  await show('admin', s);
  await act(async () => { fireEvent.click(chip()!); });
  await act(async () => { fireEvent.click(button('proposal-approve')); });
  expect(storeThenApply).toHaveBeenCalledTimes(1);
  expect(storeThenApply).toHaveBeenCalledWith(OPS, 'p1', expect.any(Function));
  expect(s.approveProposal).toHaveBeenCalledWith('d1', 'p1', { applied: 2, document: DOCUMENT });
  expect(shown).toEqual([OPS]);
  expect(pushes.at(-1)).toEqual({ severity: 'success', message: '2 changes approved and made' });
  expect(chip()).toBeNull();
});

it.each([
  ['conflict', 'This diagram was changed somewhere else, so nothing was approved: try again once it has refreshed'],
  ['error', "Couldn't save the change, so nothing was approved: try again"]
])('storing fails (%s): nothing shows, it says so, and the proposal keeps waiting', async (reason, message) => {
  const s = storage([[proposal('p1')]], () => ({ ok: false, reason, message: 'refused' }));
  await show('owner', s);
  await act(async () => { fireEvent.click(chip()!); });
  await act(async () => { fireEvent.click(button('proposal-approve')); });
  expect(s.approveProposal).toHaveBeenCalledTimes(1);
  expect(shown).toEqual([]);
  expect(pushes.at(-1)).toEqual({ severity: 'error', message });
  expect(chip()?.textContent).toBe('1 to approve');
  expect(s.listProposals).toHaveBeenCalledTimes(2);
});

it('already decided in another window: nothing shows and it leaves the list', async () => {
  const s = storage([[proposal('p1')], []], () => ({ ok: false, reason: 'already-decided', message: 'rejected' }));
  await show('owner', s);
  await act(async () => { fireEvent.click(chip()!); });
  await act(async () => { fireEvent.click(button('proposal-approve')); });
  expect(shown).toEqual([]);
  expect(pushes.at(-1)).toEqual({ severity: 'error', message: 'That change was already decided in another window: nothing was changed' });
  expect(chip()).toBeNull();
});

it('earlier edits could not be saved first: nothing is sent for approval', async () => {
  storeThenApply.mockResolvedValue({ status: 'unsaved', steps: [] });
  const s = storage([[proposal('p1')]]);
  await show('owner', s);
  await act(async () => { fireEvent.click(chip()!); });
  await act(async () => { fireEvent.click(button('proposal-approve')); });
  expect(s.approveProposal).not.toHaveBeenCalled();
  expect(pushes.at(-1)?.severity).toBe('error');
  expect(pushes.at(-1)?.message).toMatch(/latest edits couldn't be saved/);
  expect(chip()?.textContent).toBe('1 to approve');
});

it('a step that no longer fits is shown with why, and only the rest is made', async () => {
  mockPlan.mockReturnValue([step(0, 'Add “Cache”'), step(1, 'Remove “FTP”', 'not_applicable', 'No item named “FTP”')]);
  const s = storage([[proposal('p1')]]);
  await show('owner', s);
  await act(async () => { fireEvent.click(chip()!); });
  expect(screen.getByText('Not applicable: No item named “FTP”')).toBeTruthy();
  expect(button('proposal-approve').textContent).toBe('Approve the 1 that fit');
  await act(async () => { fireEvent.click(button('proposal-approve')); });
  expect(storeThenApply).toHaveBeenCalledWith([OPS[0]], 'p1', expect.any(Function));
  expect(s.approveProposal).toHaveBeenCalledWith('d1', 'p1', { applied: 1, document: DOCUMENT });
});

it('nothing fits any more: Approve is off; Reject records it and changes nothing', async () => {
  mockPlan.mockReturnValue([step(0, 'Remove “FTP”', 'not_applicable', 'gone')]);
  const s = storage([[proposal('p1')]]);
  await show('owner', s);
  await act(async () => { fireEvent.click(chip()!); });
  expect(button('proposal-approve').disabled).toBe(true);
  await act(async () => { fireEvent.click(button('proposal-reject')); });
  expect(s.rejectProposal).toHaveBeenCalledWith('d1', 'p1');
  expect(storeThenApply).not.toHaveBeenCalled();
  expect(pushes.at(-1)).toEqual({ severity: 'success', message: 'Change rejected' });
});

it('on a read-only view nothing is made', async () => {
  useAssistantPageStore.setState({ canChangePage: () => false });
  const s = storage([[proposal('p1')]]);
  await show('owner', s);
  await act(async () => { fireEvent.click(chip()!); });
  await act(async () => { fireEvent.click(button('proposal-approve')); });
  expect(storeThenApply).not.toHaveBeenCalled();
  expect(s.approveProposal).not.toHaveBeenCalled();
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

it('after the last one is decided, a later proposal shows the chip, not an open dialog', async () => {
  const s = storage([[proposal('p1')], [proposal('p2')]]);
  await show('owner', s);
  await act(async () => { fireEvent.click(chip()!); });
  await act(async () => { fireEvent.click(button('proposal-approve')); });
  expect(chip()).toBeNull();
  await act(async () => { window.dispatchEvent(new CustomEvent(PROPOSALS_CHANGED_EVENT, { detail: { id: 'd1' } })); });
  expect(chip()?.textContent).toBe('1 to approve');
  expect(document.querySelector('[data-axoview-id="proposal"]')).toBeNull();
});

it('an arrival already announced live (naming the agent) does not pop up a second time', async () => {
  const s = storage([[], [proposal('p1')]]);
  await show('owner', s);
  const before = pushes.length;
  await act(async () => { window.dispatchEvent(new CustomEvent(PROPOSALS_CHANGED_EVENT, { detail: { id: 'd1', announced: true } })); });
  expect(chip()?.textContent).toBe('1 to approve');
  expect(pushes.length).toBe(before);
});

it('Review on a live notice opens this diagram\'s waiting proposals once', async () => {
  const s = storage([[proposal('p1')]]);
  await show('owner', s);
  expect(document.querySelector('[data-axoview-id="proposal"]')).toBeNull();
  await act(async () => { useAssistantPageStore.getState().setReviewProposalsOf('d1'); });
  expect(document.querySelector('[data-axoview-id="proposal"]')).not.toBeNull();
  expect(useAssistantPageStore.getState().reviewProposalsOf).toBeNull();
});

it('Review for another diagram leaves this one alone', async () => {
  const s = storage([[proposal('p1')]]);
  await show('owner', s);
  await act(async () => { useAssistantPageStore.getState().setReviewProposalsOf('d2'); });
  expect(document.querySelector('[data-axoview-id="proposal"]')).toBeNull();
  expect(useAssistantPageStore.getState().reviewProposalsOf).toBe('d2');
  useAssistantPageStore.getState().setReviewProposalsOf(null);
});

it('the refresh after a decision is quiet, even when it finds a proposal made a moment ago', async () => {
  // The CI race (2026-11-13): a resolve event's refresh saw the next proposal
  // before that proposal's named notice arrived, and popped up a nameless one.
  const s = storage([[], [proposal('p2')]]);
  await show('owner', s);
  const before = pushes.length;
  await act(async () => { window.dispatchEvent(new CustomEvent(PROPOSALS_CHANGED_EVENT, { detail: { id: 'd1', action: 'resolve' } })); });
  expect(chip()?.textContent).toBe('1 to approve');
  expect(pushes.length).toBe(before);
});
