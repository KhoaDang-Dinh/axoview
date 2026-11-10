import { Box, MenuItem, Select, Typography } from '@mui/material';
import type { AgentLevel } from '../../services/storage/types';

/**
 * What this person lets their AI agent do (ADR 0057 addendum 3, owner
 * decisions 2026-11-10). The agent works on the person's own account and the
 * person is its one admin, so this is a single setting for the account, kept
 * on the server: "Read only" (it suggests; the person makes each change) or
 * "Changes need my approval" (each change it suggests can be approved here,
 * in the chat, and is then carried out). On a diagram the person may not
 * change (shared with them as Read only), the agent is Read only too,
 * whatever this says.
 */
export function AgentLevelSwitch({ level, onChange, busy, canChange }: {
  level: AgentLevel;
  onChange: (level: AgentLevel) => void;
  busy: boolean;
  /** Whether the person may change the open diagram. */
  canChange: boolean;
}) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5, minWidth: 0 }} data-axoview-id="ai-agent-level">
      <Typography variant="caption" color="text.secondary" component="label" htmlFor="ai-agent-level-select"
        sx={{ flexShrink: 0 }}>
        Nova may
      </Typography>
      <Select
        size="small"
        variant="standard"
        disableUnderline
        value={level}
        disabled={busy}
        onChange={(event) => onChange(event.target.value as AgentLevel)}
        inputProps={{ id: 'ai-agent-level-select', 'data-axoview-id': 'ai-agent-level-select', 'aria-label': 'What Nova may do' }}
        // The chat floats above the editor (z-index 1400); the menu must open above it.
        MenuProps={{ sx: { zIndex: 1500 } }}
        sx={{ fontSize: 12, minWidth: 0 }}
      >
        <MenuItem value="viewer" sx={{ fontSize: 13 }}>Read only: suggest, never change</MenuItem>
        <MenuItem value="proposer" sx={{ fontSize: 13 }}>Changes need my approval</MenuItem>
      </Select>
      {level === 'proposer' && !canChange && (
        <Typography variant="caption" color="text.secondary" data-axoview-id="ai-agent-level-capped" noWrap
          title="You can only view this diagram, so Nova can only suggest here.">
          · Read only here, like you
        </Typography>
      )}
    </Box>
  );
}
