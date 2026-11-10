/**
 * Changes waiting for approval (ADR 0059, ADR 0057 addendum 3): an outside
 * agent working as this person proposed changes through the workspace MCP
 * server. They wait for this person alone: a small "N to approve" chip in the
 * toolbar of the open diagram opens them.
 *
 * Each proposal is a list of operations (the diagramAgent vocabulary). They
 * are checked against the page as it is now, so a step that no longer applies
 * says why instead of overwriting anything. Approve carries out the steps that
 * apply, through the editor, as one undoable change saved like any edit (the
 * same path as approving the in-app assistant: ADR 0052 addendum 2026-11-10),
 * then records the decision for the agent. Reject records it and changes
 * nothing.
 *
 * The list refreshes when the diagram opens and whenever the sync stream says
 * a proposal was made or decided (hooks/useRealtimeSync.ts).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Typography
} from '@mui/material';
import { diagramAgent } from 'axoview';
import { notificationStore } from '../stores/notificationStore';
import { useAssistantPageStore } from '../stores/assistantPageStore';
import { PROPOSALS_CHANGED_EVENT } from '../hooks/useRealtimeSync';
import type { DiagramRole, Proposal, StorageProvider } from '../services/storage/types';

type PlanStep = diagramAgent.PlanStep;

export type ProposalStorage = Pick<StorageProvider, 'listProposals' | 'resolveProposal'>;

export function ProposalPrompt({
  diagramId,
  role,
  storage
}: {
  diagramId: string;
  role: DiagramRole | undefined;
  storage: ProposalStorage;
}) {
  const { t } = useTranslation('app');
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const readPage = useAssistantPageStore((state) => state.readPage);
  const applyToPage = useAssistantPageStore((state) => state.applyToPage);
  const canChangePage = useAssistantPageStore((state) => state.canChangePage);
  // Anyone who may change the diagram checks when it opens and whenever the
  // sync stream announces a proposal (the server announces one only to the
  // person whose agent made it). No role means their own diagram, unshared.
  const mayReview = role !== 'viewer';
  // Proposals already announced with a pop-up, so each arrives once.
  const announcedRef = useRef<Set<string>>(new Set());
  // Read through a ref: the list refreshes on diagram and sync changes only,
  // never because a render handed over a new translate function.
  const tRef = useRef(t);
  tRef.current = t;

  const refresh = useCallback(async () => {
    if (!mayReview || !storage.listProposals) {
      setProposals([]);
      return;
    }
    const waiting = await storage.listProposals(diagramId).catch(() => [] as Proposal[]);
    const fresh = waiting.filter((p) => !announcedRef.current.has(p.id));
    for (const p of fresh) announcedRef.current.add(p.id);
    if (fresh.length > 0) {
      notificationStore.push({
        severity: 'info',
        message: tRef.current('proposals.arrived', {
          count: waiting.length,
          defaultValue: waiting.length === 1
            ? 'A change to this diagram is waiting for your approval'
            : `${waiting.length} changes to this diagram are waiting for your approval`
        })
      });
    }
    setProposals(waiting);
  }, [diagramId, mayReview, storage]);

  useEffect(() => {
    setProposals([]);
    announcedRef.current = new Set();
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onChanged = (event: Event) => {
      if ((event as CustomEvent<{ id?: string }>).detail?.id === diagramId) void refresh();
    };
    window.addEventListener(PROPOSALS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(PROPOSALS_CHANGED_EVENT, onChanged);
  }, [diagramId, refresh]);

  /** The proposal's steps checked against the page as it is now. */
  const planOf = useCallback((proposal: Proposal): PlanStep[] => {
    const page = readPage?.();
    if (!page) return [];
    return diagramAgent.planOperations(page.model, proposal.viewId ?? undefined, proposal.operations);
  }, [readPage]);

  const record = useCallback(async (proposal: Proposal, decision: 'approve' | 'reject', applied?: number) => {
    const result = storage.resolveProposal
      ? await storage.resolveProposal(diagramId, proposal.id, decision, applied)
      : { ok: false as const, reason: 'error', message: '' };
    setProposals((current) => current.filter((p) => p.id !== proposal.id));
    return result.ok;
  }, [diagramId, storage]);

  const approve = useCallback(async (proposal: Proposal) => {
    if (!applyToPage || !canChangePage?.()) {
      notificationStore.push({ severity: 'error', message: t('proposals.cannotChange', 'You can only view this diagram, so nothing was changed') });
      return;
    }
    setBusy(proposal.id);
    try {
      const ready = planOf(proposal).filter((step) => step.status === 'ready');
      if (ready.length === 0) {
        notificationStore.push({
          severity: 'error',
          message: t('proposals.nothingApplies', 'None of these changes fit the page as it is now: nothing was changed')
        });
        return;
      }
      const outcomes = applyToPage(ready.map((step) => proposal.operations[step.index]), proposal.viewId ?? undefined);
      const made = outcomes.filter((step) => step.status === 'ready').length;
      const saved = await record(proposal, 'approve', made);
      notificationStore.push({
        severity: saved ? 'success' : 'warning',
        message: saved
          ? t('proposals.made', { count: made, defaultValue: made === 1 ? 'Change approved and made' : `${made} changes approved and made` })
          : t('proposals.madeNotRecorded', "Made the changes, but couldn't tell the agent: it may ask again")
      });
    } finally {
      setBusy(null);
    }
  }, [applyToPage, canChangePage, planOf, record, t]);

  const reject = useCallback(async (proposal: Proposal) => {
    setBusy(proposal.id);
    try {
      const ok = await record(proposal, 'reject');
      notificationStore.push(ok
        ? { severity: 'success', message: t('proposals.rejected', 'Change rejected') }
        : { severity: 'error', message: t('proposals.failed', "Couldn't record your decision: try again") });
      if (!ok) void refresh();
    } finally {
      setBusy(null);
    }
  }, [record, refresh, t]);

  if (!mayReview || proposals.length === 0) return null;

  const who = (p: Proposal) => p.by.agent
    ? t('proposals.fromAgent', { name: p.by.agent, defaultValue: `From ${p.by.agent}` })
    : t('proposals.fromYourAgent', 'From your AI agent');

  return (
    <>
      <Chip
        size="small"
        color="warning"
        label={t('proposals.chip', { count: proposals.length, defaultValue: `${proposals.length} to approve` })}
        onClick={() => setOpen(true)}
        data-axoview-id="proposals-chip"
        sx={{ ml: 0.5 }}
      />
      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="sm" fullWidth data-axoview-id="proposals-dialog">
        <DialogTitle>{t('proposals.title', 'Changes waiting for approval')}</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5}>
            {proposals.map((p) => {
              const steps = open ? planOf(p) : [];
              const ready = steps.filter((step) => step.status === 'ready').length;
              return (
                <Box key={p.id} data-axoview-id="proposal" sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1.25 }}>
                  <Typography variant="body2" fontWeight={600}>
                    {who(p)}, {new Date(p.createdAt).toLocaleString()}
                  </Typography>
                  {p.note && (
                    <Typography variant="body2" sx={{ fontStyle: 'italic', overflowWrap: 'anywhere' }} data-axoview-id="proposal-note">
                      {p.note}
                    </Typography>
                  )}
                  <Box component="ul" sx={{ m: 0, mt: 0.5, pl: 2.5 }}>
                    {steps.filter((step) => step.status !== 'invalid').map((step) => (
                      <Typography component="li" variant="body2" key={step.index} data-axoview-id="proposal-step"
                        data-status={step.status} sx={{ color: step.status === 'ready' ? 'text.primary' : 'text.disabled', overflowWrap: 'anywhere' }}>
                        {step.summary}
                        {step.status !== 'ready' && step.problem && (
                          <Typography component="span" variant="caption" color="warning.main" display="block">
                            {t('proposals.notApplicable', { problem: step.problem, defaultValue: `Not applicable: ${step.problem}` })}
                          </Typography>
                        )}
                      </Typography>
                    ))}
                  </Box>
                  <Stack direction="row" spacing={1} sx={{ mt: 1 }} justifyContent="flex-end">
                    <Button size="small" onClick={() => void reject(p)} disabled={busy !== null}
                      data-axoview-id="proposal-reject" sx={{ textTransform: 'none' }}>
                      {t('proposals.reject', 'Reject')}
                    </Button>
                    <Button size="small" variant="contained" onClick={() => void approve(p)}
                      disabled={busy !== null || ready === 0} data-axoview-id="proposal-approve" sx={{ textTransform: 'none' }}>
                      {ready === steps.length
                        ? t('proposals.approve', 'Approve')
                        : t('proposals.approveSome', { count: ready, defaultValue: `Approve the ${ready} that fit` })}
                    </Button>
                  </Stack>
                </Box>
              );
            })}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Typography variant="caption" color="text.secondary" sx={{ flex: 1, pl: 2 }}>
            {t('proposals.undoHint', 'An approval is one change: Undo takes it back.')}
          </Typography>
          <Button onClick={() => setOpen(false)} sx={{ textTransform: 'none' }}>
            {t('proposals.close', 'Close')}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
