/**
 * The consent page an outside agent's sign-in brings the person to (ADR 0059):
 * /app/oauth/consent?request=<id>, after they signed in with their usual
 * account (CognitoSessionProvider shows sign-in first and comes back here).
 *
 * It says which app is asking, where it came from and where it goes back to
 * (MCP authorization: the redirect host is always shown, with a warning when
 * it is an app on this computer), and what it may do: read, and, if the
 * person leaves it ticked, propose changes that each wait for their approval.
 * Allow or Deny sends the browser back to the app with the answer.
 */
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Alert, Box, Button, Checkbox, CircularProgress, FormControlLabel, Paper, Stack, Typography } from '@mui/material';
import { dismissBootScreens } from '../../utils/bootScreen';
import { useCognitoSessionStore } from '../../stores/cognitoSessionStore';
import {
  decideConsent, readConsentRequest, SCOPE_PROPOSE, type ConsentRequest
} from '../../services/agentConnections';

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; request: ConsentRequest }
  | { kind: 'expired' }
  | { kind: 'error' }
  | { kind: 'leaving' };

export function AgentConsentPage({ go = (href: string) => window.location.assign(href) }: { go?: (href: string) => void }) {
  const [params] = useSearchParams();
  const requestId = params.get('request') ?? '';
  const email = useCognitoSessionStore((state) => (state.user as { email?: string } | null)?.email ?? null);
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [propose, setPropose] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => { dismissBootScreens(); }, []);
  useEffect(() => {
    let live = true;
    readConsentRequest(requestId)
      .then((request) => {
        if (!live) return;
        setState(request ? { kind: 'ready', request } : { kind: 'expired' });
        if (request) setPropose(request.scopes.includes(SCOPE_PROPOSE));
      })
      .catch(() => { if (live) setState({ kind: 'error' }); });
    return () => { live = false; };
  }, [requestId]);

  const decide = async (approve: boolean) => {
    setBusy(true);
    try {
      const redirect = await decideConsent(requestId, approve, approve ? (propose ? [SCOPE_PROPOSE] : []) : undefined);
      if (!redirect) {
        setState({ kind: 'expired' });
        return;
      }
      setState({ kind: 'leaving' });
      go(redirect);
    } catch {
      setState({ kind: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box sx={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', p: 2, bgcolor: 'background.default' }}>
      <Paper elevation={2} sx={{ p: 3, width: '100%', maxWidth: 480 }} data-axoview-id="agent-consent">
        {state.kind === 'loading' && <CircularProgress size={28} />}
        {state.kind === 'expired' && (
          <Typography data-axoview-id="agent-consent-expired">
            This sign-in request has expired or was already answered. Start again from your AI app.
          </Typography>
        )}
        {state.kind === 'error' && (
          <Typography color="error" role="alert">Something went wrong. Start again from your AI app.</Typography>
        )}
        {state.kind === 'leaving' && (
          <Typography data-axoview-id="agent-consent-done">Done. You can go back to your AI app.</Typography>
        )}
        {state.kind === 'ready' && (
          <Stack spacing={2}>
            <Typography variant="h6" data-axoview-id="agent-consent-title">
              Connect {state.request.clientName} to Axoview?
            </Typography>
            <Typography variant="body2">
              It will work on your diagrams as you{email ? ` (${email})` : ''}, never with more access than you have.
            </Typography>
            <Box>
              <Typography variant="body2" data-axoview-id="agent-consent-from">
                {state.request.clientHost
                  ? <>Identified by <b>{state.request.clientHost}</b>.</>
                  : <>It registered itself; Axoview cannot confirm who made it.</>}
                {' '}It goes back to <b>{state.request.redirectHost}</b>.
              </Typography>
              {state.request.loopback && (
                <Alert severity="warning" sx={{ mt: 1 }} data-axoview-id="agent-consent-loopback">
                  That is an app on this computer. Allow it only if you just started connecting it yourself.
                </Alert>
              )}
            </Box>
            <Box>
              <Typography variant="subtitle2">It may</Typography>
              <Typography variant="body2">• read your diagrams and the ones shared with you</Typography>
              {state.request.scopes.includes(SCOPE_PROPOSE) && (
                <FormControlLabel
                  sx={{ mt: 0.5, alignItems: 'flex-start' }}
                  control={<Checkbox size="small" checked={propose} onChange={(e) => setPropose(e.target.checked)}
                    sx={{ pt: 0.25 }} inputProps={{ 'aria-label': 'Let it propose changes' }} />}
                  label={<Typography variant="body2">propose changes: nothing changes until you approve each one in Axoview</Typography>}
                />
              )}
            </Box>
            <Typography variant="caption" color="text.secondary">
              You can change this or disconnect it any time under Axoview AI → + → Connected apps.
            </Typography>
            <Stack direction="row" spacing={1} justifyContent="flex-end">
              <Button onClick={() => void decide(false)} disabled={busy} data-axoview-id="agent-consent-deny">Deny</Button>
              <Button variant="contained" onClick={() => void decide(true)} disabled={busy} data-axoview-id="agent-consent-allow">
                Allow
              </Button>
            </Stack>
          </Stack>
        )}
      </Paper>
    </Box>
  );
}
