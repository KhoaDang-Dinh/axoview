import { useState } from 'react';
import { Box, Button, Checkbox, Typography } from '@mui/material';
import type { diagramAgent } from 'axoview';

type PlanStep = diagramAgent.PlanStep;

/**
 * The assistant's suggested changes as a checklist the user works through.
 * Nothing here edits the diagram: each step says what to change, why, and how
 * to do it by hand. Ticks are local to this message (a memory aid, not state).
 */
export function SuggestionChecklist({ steps, onRecheck }: {
  steps: PlanStep[];
  /** Re-checks the suggestions against the page as it is now. */
  onRecheck?: () => void;
}) {
  const [done, setDone] = useState<Set<number>>(new Set());
  const visible = steps.filter((step) => step.status !== 'invalid');
  if (visible.length === 0) return null;
  const toggle = (index: number) => setDone((current) => {
    const next = new Set(current);
    if (next.has(index)) next.delete(index); else next.add(index);
    return next;
  });

  return (
    <Box data-axoview-id="ai-suggestions" sx={{ mt: 1, border: 1, borderColor: 'divider', borderRadius: 2, p: 1 }}>
      <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 0.5 }}>
        Suggested changes — make them yourself; nothing is changed automatically.
      </Typography>
      {visible.map((step) => {
        const applicable = step.status === 'ready';
        return (
          <Box key={step.index} sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.5, py: 0.5 }}
            data-axoview-id={`ai-suggestion-${step.index}`} data-status={step.status}>
            <Checkbox size="small" sx={{ p: 0.25 }} disabled={!applicable} checked={done.has(step.index)}
              onChange={() => toggle(step.index)} inputProps={{ 'aria-label': `Done: ${step.summary}` }} />
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="body2" data-done={done.has(step.index) ? 'true' : undefined} sx={{
                overflowWrap: 'anywhere',
                textDecoration: done.has(step.index) ? 'line-through' : 'none',
                color: applicable ? 'text.primary' : 'text.disabled'
              }}>
                {step.summary}
              </Typography>
              {step.reason && (
                <Typography variant="caption" color="text.secondary" component="div" sx={{ fontStyle: 'italic' }}>
                  {step.reason}
                </Typography>
              )}
              {applicable ? (
                <Typography variant="caption" color="text.secondary" component="div">{step.howTo}</Typography>
              ) : (
                <Typography variant="caption" color="warning.main" component="div">
                  Not applicable: {step.problem}
                </Typography>
              )}
            </Box>
          </Box>
        );
      })}
      {onRecheck && (
        <Button size="small" onClick={onRecheck} sx={{ textTransform: 'none', mt: 0.5 }}
          data-axoview-id="ai-suggestions-recheck">
          Check again against the page
        </Button>
      )}
    </Box>
  );
}
