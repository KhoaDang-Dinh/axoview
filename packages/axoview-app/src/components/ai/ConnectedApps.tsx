import { useCallback, useEffect, useState } from 'react';
import { Box, Button, FormControlLabel, Switch, Typography } from '@mui/material';
import { notificationStore } from '../../stores/notificationStore';
import {
  disconnectAgent, listAgentGrants, setAgentMayPropose, SCOPE_PROPOSE, type AgentGrant
} from '../../services/agentConnections';

/**
 * The outside agents this person connected through MCP sign-in (ADR 0059),
 * in the assistant's "Connect your AI" view: each one's name and where it
 * signs in from, whether it may propose changes (each waits for approval),
 * and Disconnect, which ends every token it holds.
 */
export function ConnectedApps() {
  const [grants, setGrants] = useState<AgentGrant[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    listAgentGrants().then(setGrants).catch(() => setGrants([]));
  }, []);
  useEffect(load, [load]);

  const toggle = async (grant: AgentGrant, mayPropose: boolean) => {
    setBusy(grant.id);
    try {
      const updated = await setAgentMayPropose(grant.id, mayPropose);
      setGrants((current) => current?.map((g) => (g.id === grant.id ? updated : g)) ?? null);
    } catch {
      notificationStore.push({ severity: 'error', message: `Couldn't change what ${grant.clientName} may do: try again` });
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async (grant: AgentGrant) => {
    setBusy(grant.id);
    try {
      await disconnectAgent(grant.id);
      setGrants((current) => current?.filter((g) => g.id !== grant.id) ?? null);
      notificationStore.push({ severity: 'success', message: `${grant.clientName} is disconnected` });
    } catch {
      notificationStore.push({ severity: 'error', message: `Couldn't disconnect ${grant.clientName}: try again` });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Box data-axoview-id="ai-connected-apps" sx={{ mb: 2 }}>
      <Typography variant="subtitle2" sx={{ mb: 0.5 }}>Connected apps</Typography>
      {grants === null ? null : grants.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          None yet. Choose your AI below to connect it; it works on your diagrams as you.
        </Typography>
      ) : grants.map((grant) => (
        <Box key={grant.id} data-axoview-id="ai-connected-app" data-client={grant.clientName}
          sx={{ border: 1, borderColor: 'divider', borderRadius: 2, p: 1, mb: 1 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Typography variant="body2" sx={{ flex: 1, minWidth: 0, fontWeight: 600 }} noWrap title={grant.clientName}>
              {grant.clientName}
            </Typography>
            <Button size="small" color="error" onClick={() => void disconnect(grant)} disabled={busy === grant.id}
              sx={{ textTransform: 'none' }} aria-label={`Disconnect ${grant.clientName}`}>
              Disconnect
            </Button>
          </Box>
          <Typography variant="caption" color="text.secondary" display="block">
            Signs in through {grant.redirectHost} · since {new Date(grant.createdAt).toLocaleDateString()}
          </Typography>
          <FormControlLabel
            sx={{ ml: 0 }}
            control={<Switch size="small" checked={grant.scopes.includes(SCOPE_PROPOSE)} disabled={busy === grant.id}
              onChange={(e) => void toggle(grant, e.target.checked)}
              slotProps={{ input: { 'aria-label': `${grant.clientName} may propose changes` } }} />}
            label={<Typography variant="caption">May propose changes (each waits for your approval)</Typography>}
          />
        </Box>
      ))}
    </Box>
  );
}
