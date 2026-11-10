/**
 * Changes waiting for approval (ADR 0057; owner decision 2026-11-10): a save
 * made under "Change needs approval" (AI agents) is stored as a proposal. The
 * owner and Full admins of the open diagram see a small "N to approve" chip
 * in the toolbar; it opens a list where each proposal is approved (saved like
 * any save, so everyone who has the diagram gets it) or rejected. A proposal
 * made before the diagram last changed is marked: approving it replaces those
 * changes, so it takes a second, explicit "Apply anyway".
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
import { notificationStore } from '../stores/notificationStore';
import { PROPOSALS_CHANGED_EVENT } from '../hooks/useRealtimeSync';
import type { DiagramRole, Proposal, StorageProvider } from '../services/storage/types';

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

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
  // Known reviewers check on open. Anyone not known to be Read only or
  // "needs approval" (an owner whose diagram was unshared when it opened has
  // no role yet) checks when the sync stream announces a proposal: the
  // server only announces them to the owner and Full admins.
  const reviews = role === 'owner' || role === 'admin';
  const mayReview = role !== 'viewer' && role !== 'proposer';
  // Proposals already announced with a pop-up, so each arrives once.
  const announcedRef = useRef<Set<string>>(new Set());
  // Read through a ref: the list refreshes on diagram and sync changes only,
  // never because a render handed over a new translate function.
  const tRef = useRef(t);
  tRef.current = t;

  const refresh = useCallback(async (announced = false) => {
    if (!(reviews || (announced && mayReview)) || !storage.listProposals) {
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
  }, [diagramId, reviews, mayReview, storage]);

  useEffect(() => {
    setProposals([]);
    announcedRef.current = new Set();
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onChanged = (event: Event) => {
      if ((event as CustomEvent<{ id?: string }>).detail?.id === diagramId) void refresh(true);
    };
    window.addEventListener(PROPOSALS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(PROPOSALS_CHANGED_EVENT, onChanged);
  }, [diagramId, refresh]);

  const decide = useCallback(async (proposal: Proposal, decision: 'approve' | 'reject', force = false) => {
    if (!storage.resolveProposal) return;
    setBusy(proposal.id);
    try {
      const result = await storage.resolveProposal(diagramId, proposal.id, decision, force);
      if (result.ok) {
        notificationStore.push({
          severity: 'success',
          message: decision === 'approve'
            ? t('proposals.approved', 'Change approved and saved')
            : t('proposals.rejected', 'Change rejected')
        });
        setProposals((current) => current.filter((p) => p.id !== proposal.id));
      } else if (result.reason === 'stale') {
        setProposals((current) => current.map((p) => (p.id === proposal.id ? { ...p, stale: true } : p)));
        notificationStore.push({
          severity: 'error',
          message: t('proposals.stale', 'The diagram changed since this was proposed: approving would replace those changes')
        });
      } else {
        notificationStore.push({
          severity: 'error',
          message: t('proposals.failed', "Couldn't record your decision: try again")
        });
        void refresh();
      }
    } finally {
      setBusy(null);
    }
  }, [diagramId, refresh, storage, t]);

  if (!mayReview || proposals.length === 0) return null;

  const who = (p: Proposal) =>
    p.by.email || (p.by.kind === 'agent' ? t('proposals.agent', 'An AI agent') : t('proposals.someone', 'Someone'));

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
      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="xs" fullWidth data-axoview-id="proposals-dialog">
        <DialogTitle>{t('proposals.title', 'Changes waiting for approval')}</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5}>
            {proposals.map((p) => (
              <Box
                key={p.id}
                data-axoview-id="proposal"
                data-stale={p.stale ? 'true' : undefined}
                sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1.25 }}
              >
                <Typography variant="body2">
                  {t('proposals.by', {
                    who: who(p),
                    when: new Date(p.createdAt).toLocaleString(),
                    defaultValue: `${who(p)}, ${new Date(p.createdAt).toLocaleString()}`
                  })}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {t('proposals.summary', {
                    items: p.summary.items,
                    pages: p.summary.pages,
                    connectors: p.summary.connectors,
                    defaultValue: `Proposes ${count(p.summary.items, 'item')}, ${count(p.summary.connectors, 'connector')} on ${count(p.summary.pages, 'page')}`
                  })}
                </Typography>
                {p.stale && (
                  <Typography variant="caption" color="warning.main" display="block">
                    {t('proposals.staleNote', 'The diagram changed since: approving replaces those changes.')}
                  </Typography>
                )}
                <Stack direction="row" spacing={1} sx={{ mt: 1 }} justifyContent="flex-end">
                  <Button
                    size="small"
                    onClick={() => void decide(p, 'reject')}
                    disabled={busy !== null}
                    data-axoview-id="proposal-reject"
                    sx={{ textTransform: 'none' }}
                  >
                    {t('proposals.reject', 'Reject')}
                  </Button>
                  <Button
                    size="small"
                    variant="contained"
                    color={p.stale ? 'warning' : 'primary'}
                    onClick={() => void decide(p, 'approve', p.stale)}
                    disabled={busy !== null}
                    data-axoview-id="proposal-approve"
                    sx={{ textTransform: 'none' }}
                  >
                    {p.stale ? t('proposals.applyAnyway', 'Apply anyway') : t('proposals.approve', 'Approve')}
                  </Button>
                </Stack>
              </Box>
            ))}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)} sx={{ textTransform: 'none' }}>
            {t('proposals.close', 'Close')}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
