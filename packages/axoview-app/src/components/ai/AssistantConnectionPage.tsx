import { useEffect } from 'react';
import { Box, Button, Paper, Typography } from '@mui/material';
import { ArrowBack } from '@mui/icons-material';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { dismissBootScreens } from '../../utils/bootScreen';
import { findAiConnector } from '../../stores/assistantStore';

export function AssistantConnectionPage() {
  const { clientId } = useParams();
  const client = findAiConnector(clientId);
  const navigate = useNavigate();
  const location = useLocation();
  const state = location.state as { returnTo?: string } | null;
  const returnTo = state?.returnTo && state.returnTo.startsWith('/') && !state.returnTo.startsWith('//')
    ? state.returnTo : '/';
  useEffect(() => { dismissBootScreens(); }, []);

  return (
    <Box sx={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', p: 2, bgcolor: 'background.default' }}>
      <Paper elevation={2} sx={{ p: 3, width: '100%', maxWidth: 520 }}>
        <Typography variant="h6" gutterBottom>{client ? `Connect ${client.label}` : 'AI client not found'}</Typography>
        {client ? (
          <>
            <Typography sx={{ mb: 2 }} variant="body2">
              {client.family} integration with Axoview is planned. An external AI client must initiate
              the MCP OAuth connection before Axoview can display a real permission consent screen.
            </Typography>
            <Typography variant="subtitle2">Planned permissions</Typography>
            <Typography variant="body2" sx={{ my: 1 }}>Read authorized diagrams and search permitted resources. Editing is disabled by default.</Typography>
            <Typography color="text.secondary" variant="caption" display="block" sx={{ mb: 2 }}>
              Preview only — no credentials are requested, no OAuth flow is started, and no connection is installed.
            </Typography>
          </>
        ) : <Typography variant="body2">This connection type is not supported.</Typography>}
        <Button variant="contained" startIcon={<ArrowBack />} onClick={() => navigate(returnTo)}>Return to Axoview</Button>
      </Paper>
    </Box>
  );
}
