/**
 * Changes waiting for approval (ADR 0057 addendum 3): a change an AI agent made
 * through the API under "Changes need my approval" waits for its own person
 * (the server lists only theirs). They get a chip and a pop-up when one
 * arrives, approve or reject it, and a proposal made before the diagram
 * changed needs "Apply anyway". Someone Read only on the diagram never sees it.
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

import { ProposalPrompt } from '../ProposalPrompt';
import { PROPOSALS_CHANGED_EVENT } from '../../hooks/useRealtimeSync';
import type { DiagramRole, Proposal, ProposalDecision } from '../../services/storage/types';

const proposal = (id: string, stale = false): Proposal => ({
  id,
  by: { sub: 'me', agent: 'claude-code' },
  createdAt: '2026-11-10T07:00:00.000Z',
  summary: { items: 3, pages: 1, connectors: 2 },
  stale
});

function storage(waiting: Proposal[][], decide?: (pid: string, d: string, force?: boolean) => ProposalDecision) {
  let call = 0;
  return {
    listProposals: jest.fn(async () => waiting[Math.min(call++, waiting.length - 1)]),
    resolveProposal: jest.fn(async (_id: string, pid: string, d: 'approve' | 'reject', force?: boolean) =>
      decide ? decide(pid, d, force) : { ok: true as const })
  };
}

const chip = () => document.querySelector('[data-axoview-id="proposals-chip"]');

async function show(role: DiagramRole, s: ReturnType<typeof storage>) {
  await act(async () => { render(<ProposalPrompt diagramId="d1" role={role} storage={s} />); });
}

beforeEach(() => { pushes.length = 0; });

it('a reviewer sees a chip and a pop-up for waiting changes', async () => {
  const s = storage([[proposal('p1')]]);
  await show('owner', s);
  expect(chip()?.textContent).toBe('1 to approve');
  expect(pushes).toEqual([{ severity: 'info', message: 'A change to this diagram is waiting for your approval' }]);
});

it('a Read only person never sees it, nor asks, even when the stream announces one', async () => {
  const s = storage([[proposal('p1')]]);
  await show('viewer', s);
  await act(async () => {
    window.dispatchEvent(new CustomEvent(PROPOSALS_CHANGED_EVENT, { detail: { id: 'd1' } }));
  });
  expect(chip()).toBeNull();
  expect(s.listProposals).not.toHaveBeenCalled();
});

it('approve: saved, green, the chip goes away', async () => {
  const s = storage([[proposal('p1')]]);
  await show('admin', s);
  await act(async () => { fireEvent.click(chip()!); });
  expect(screen.getByText('Your agent (Claude Code), ' + new Date('2026-11-10T07:00:00.000Z').toLocaleString())).toBeTruthy();
  await act(async () => { fireEvent.click(document.querySelector('[data-axoview-id="proposal-approve"]')!); });
  expect(s.resolveProposal).toHaveBeenCalledWith('d1', 'p1', 'approve', false);
  expect(pushes.at(-1)).toEqual({ severity: 'success', message: 'Change approved and saved' });
  expect(chip()).toBeNull();
});

it('reject: green, and it is gone', async () => {
  const s = storage([[proposal('p1')]]);
  await show('owner', s);
  await act(async () => { fireEvent.click(chip()!); });
  await act(async () => { fireEvent.click(document.querySelector('[data-axoview-id="proposal-reject"]')!); });
  expect(s.resolveProposal).toHaveBeenCalledWith('d1', 'p1', 'reject', false);
  expect(pushes.at(-1)).toEqual({ severity: 'success', message: 'Change rejected' });
});

it('the diagram changed since: approving is refused, then "Apply anyway" forces it', async () => {
  const s = storage([[proposal('p1')]], (_pid, d, force) =>
    d === 'approve' && !force ? { ok: false, reason: 'stale', message: 'changed' } : { ok: true });
  await show('owner', s);
  await act(async () => { fireEvent.click(chip()!); });
  await act(async () => { fireEvent.click(document.querySelector('[data-axoview-id="proposal-approve"]')!); });
  expect(pushes.at(-1)?.severity).toBe('error');
  const approve = document.querySelector('[data-axoview-id="proposal-approve"]')!;
  expect(approve.textContent).toBe('Apply anyway');
  await act(async () => { fireEvent.click(approve); });
  expect(s.resolveProposal).toHaveBeenLastCalledWith('d1', 'p1', 'approve', true);
  expect(chip()).toBeNull();
});

it('a new proposal on the sync stream refreshes the list, announced once', async () => {
  const s = storage([[proposal('p1')], [proposal('p1'), proposal('p2')]]);
  await show('owner', s);
  expect(pushes).toHaveLength(1);
  await act(async () => {
    window.dispatchEvent(new CustomEvent(PROPOSALS_CHANGED_EVENT, { detail: { id: 'other' } }));
  });
  expect(s.listProposals).toHaveBeenCalledTimes(1);
  await act(async () => {
    window.dispatchEvent(new CustomEvent(PROPOSALS_CHANGED_EVENT, { detail: { id: 'd1' } }));
  });
  expect(chip()?.textContent).toBe('2 to approve');
  expect(pushes).toHaveLength(2);
});

it('an owner whose diagram was unshared when it opened (no role yet) hears of a proposal', async () => {
  const s = storage([[proposal('p1')]]);
  await act(async () => { render(<ProposalPrompt diagramId="d1" role={undefined} storage={s} />); });
  expect(s.listProposals).not.toHaveBeenCalled();
  await act(async () => {
    window.dispatchEvent(new CustomEvent(PROPOSALS_CHANGED_EVENT, { detail: { id: 'd1' } }));
  });
  expect(chip()?.textContent).toBe('1 to approve');
});

