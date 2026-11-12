import { useState } from 'react';
import { Box, Button, Checkbox, Typography } from '@mui/material';
import type { diagramAgent } from 'axoview';

type PlanStep = diagramAgent.PlanStep;

/**
 * The assistant's suggested changes as a checklist the user works through.
 *
 * Read only (the default): nothing here edits the diagram. Each step says what
 * to change, why, and how to do it by hand; ticks are local to this message (a
 * memory aid, not state).
 *
 * "Changes need my approval" (ADR 0052 addendum 2026-11-10): `onApprove` is
 * given, and each step that applies to the page can be approved, alone or all
 * at once. The widget carries it out as one undoable change and reports the
 * step as `applied`. Nothing changes without a click here.
 */
export function SuggestionChecklist({ steps, applied = [], onRecheck, onApprove }: {
  steps: PlanStep[];
  /** Steps already approved and carried out, shown as done. */
  applied?: PlanStep[];
  /** Re-checks the suggestions against the page as it is now. */
  onRecheck?: () => void;
  /** Carries out these steps (by index) as one change. */
  onApprove?: (indexes: number[]) => void;
}) {
  const [done, setDone] = useState<Set<number>>(new Set());
  const appliedIndexes = new Set(applied.map((step) => step.index));
  const visible = [...applied, ...steps.filter((step) => step.status !== 'invalid' && !appliedIndexes.has(step.index))]
    .sort((a, b) => a.index - b.index);
  if (visible.length === 0) return null;
  const ready = steps.filter((step) => step.status === 'ready' && !appliedIndexes.has(step.index));
  const toggle = (index: number) => setDone((current) => {
    const next = new Set(current);
    if (next.has(index)) next.delete(index); else next.add(index);
    return next;
  });

  return (
    <Box data-axoview-id="ai-suggestions" sx={{ mt: 1, border: 1, borderColor: 'divider', borderRadius: 2, p: 1 }}>
      <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 0.5 }}>
        {onApprove
          ? 'Suggested changes — nothing changes until you approve. Undo takes an approval back.'
          : 'Suggested changes — make them yourself; nothing is changed automatically.'}
      </Typography>
      {visible.map((step) => {
        const isApplied = appliedIndexes.has(step.index);
        const applicable = step.status === 'ready';
        const struck = isApplied || done.has(step.index);
        return (
          <Box key={step.index} sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.5, py: 0.5 }}
            data-axoview-id={`ai-suggestion-${step.index}`} data-status={isApplied ? 'applied' : step.status}>
            {!onApprove && (
              <Checkbox size="small" sx={{ p: 0.25 }} disabled={!applicable} checked={done.has(step.index)}
                onChange={() => toggle(step.index)} inputProps={{ 'aria-label': `Done: ${step.summary}` }} />
            )}
            <Box sx={{ minWidth: 0, flex: 1 }}>
              <Typography variant="body2" data-done={struck ? 'true' : undefined} sx={{
                overflowWrap: 'anywhere',
                textDecoration: struck ? 'line-through' : 'none',
                color: applicable || isApplied ? 'text.primary' : 'text.disabled'
              }}>
                {step.summary}
              </Typography>
              {step.reason && !isApplied && (
                <Typography variant="caption" color="text.secondary" component="div" sx={{ fontStyle: 'italic' }}>
                  {step.reason}
                </Typography>
              )}
              {isApplied ? (
                <Typography variant="caption" color="success.main" component="div">Approved and done</Typography>
              ) : applicable ? (
                !onApprove && <Typography variant="caption" color="text.secondary" component="div">{step.howTo}</Typography>
              ) : (
                <Typography variant="caption" color="warning.main" component="div">
                  Not applicable: {step.problem}
                </Typography>
              )}
            </Box>
            {onApprove && applicable && !isApplied && (
              <Button size="small" variant="outlined" onClick={() => onApprove([step.index])}
                sx={{ textTransform: 'none', flexShrink: 0, py: 0, minWidth: 0 }}
                data-axoview-id={`ai-suggestion-approve-${step.index}`}
                aria-label={`Approve: ${step.summary}`}>
                Approve
              </Button>
            )}
          </Box>
        );
      })}
      <Box sx={{ display: 'flex', gap: 1, mt: 0.5, flexWrap: 'wrap' }}>
        {onApprove && ready.length > 1 && (
          <Button size="small" variant="contained" onClick={() => onApprove(ready.map((step) => step.index))}
            sx={{ textTransform: 'none' }} data-axoview-id="ai-suggestions-approve-all">
            Approve all {ready.length}
          </Button>
        )}
        {onRecheck && (
          <Button size="small" onClick={onRecheck} sx={{ textTransform: 'none' }}
            data-axoview-id="ai-suggestions-recheck">
            Check again against the page
          </Button>
        )}
      </Box>
    </Box>
  );
}
