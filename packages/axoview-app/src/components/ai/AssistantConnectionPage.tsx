import { useEffect, useState } from 'react';
import { Box, Button, Paper, Stack, TextField, Typography } from '@mui/material';
import { ArrowBack, ContentCopy } from '@mui/icons-material';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { dismissBootScreens } from '../../utils/bootScreen';
import { findAiConnector } from '../../stores/assistantStore';
import { useAppStorage } from '../../providers/AppStorageContext';
import { workspaceMcpUrl } from '../../services/agentConnections';

/**
 * How to connect one AI app to Axoview (ADR 0059). With the workspace MCP
 * server on (AI_MCP_ENABLED), it gives the server's URL to add to the app,
 * which then opens Axoview to sign in and asks the person to approve it.
 * Otherwise it says the connection is planned.
 */
export function AssistantConnectionPage() {
  const { clientId } = useParams();
  const client = findAiConnector(clientId);
  const navigate = useNavigate();
  const location = useLocation();
  const { runtimeConfig } = useAppStorage();
  const live = runtimeConfig?.ai?.mcpEnabled === true && runtimeConfig?.serverStorage === true;
  const [copied, setCopied] = useState(false);
  const state = location.state as { returnTo?: string } | null;
  const returnTo = state?.returnTo && state.returnTo.startsWith('/') && !state.returnTo.startsWith('//')
    ? state.returnTo : '/';
  useEffect(() => { dismissBootScreens(); }, []);
  const url = workspaceMcpUrl();
  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(() => setCopied(true)).catch(() => {});
  };

  return (
    <Box sx={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', p: 2, bgcolor: 'background.default' }}>
      <Paper elevation={2} sx={{ p: 3, width: '100%', maxWidth: 560 }}>
        <Typography variant="h6" gutterBottom>{client ? `Connect ${client.label}` : 'AI client not found'}</Typography>
        {client && live && (
          <Stack spacing={1.5} sx={{ mb: 2 }} data-axoview-id="ai-connect-live">
            <Typography variant="body2">
              Add Axoview to {client.label} as a remote MCP server with this address. {client.label} then opens
              Axoview in your browser: sign in, check what it asks for, and press Allow.
            </Typography>
            <Stack direction="row" spacing={1} alignItems="center">
              <TextField size="small" fullWidth value={url} label="MCP server URL"
                inputProps={{ readOnly: true, 'data-axoview-id': 'ai-connect-url' }} />
              <Button size="small" startIcon={<ContentCopy />} onClick={() => copy(url)} sx={{ flexShrink: 0 }}>
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </Stack>
            {client.id === 'claude-code' && (
              <Typography variant="body2" component="div">
                In a terminal: <Box component="code" sx={{ px: 0.5, bgcolor: 'action.hover', borderRadius: 0.5, overflowWrap: 'anywhere' }}
                  data-axoview-id="ai-connect-command">{`claude mcp add --transport http axoview ${url}`}</Box>, then
                run <code>/mcp</code> in Claude Code to sign in.
              </Typography>
            )}
            <Typography variant="body2">
              It can read your diagrams and the ones shared with you. If you let it propose changes, each one waits
              for you: an &ldquo;N to approve&rdquo; button appears on the diagram. Change this or disconnect it under
              Axoview AI → + → Connected apps.
            </Typography>
          </Stack>
        )}
        {client && !live && (
          <>
            <Typography sx={{ mb: 2 }} variant="body2">
              {client.family} integration with Axoview is planned. An external AI client must initiate
              the MCP OAuth connection before Axoview can display a real permission consent screen.
            </Typography>
            <Typography color="text.secondary" variant="caption" display="block" sx={{ mb: 2 }}>
              Not available on this deployment yet.
            </Typography>
          </>
        )}
        {!client && <Typography variant="body2">This connection type is not supported.</Typography>}
        <Button variant="contained" startIcon={<ArrowBack />} onClick={() => navigate(returnTo)}>Return to Axoview</Button>
      </Paper>
    </Box>
  );
}
