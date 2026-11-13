import { useEffect, useState } from 'react';
import { Box, Button, Paper, Typography } from '@mui/material';
import { apiFetch } from '../services/apiFetch';
import {
  configureProductAnalytics, readAnalyticsConsent,
  setAnalyticsConsent, trackProductEvent
} from '../services/productAnalytics';
import { useCognitoSessionStore } from '../stores/cognitoSessionStore';

/** Shown to signed-in users only after the operator enables this first-party pipeline. */
export function AnalyticsConsentBanner() {
  const signedIn = useCognitoSessionStore((state) => state.status === 'signed-in');
  const [available, setAvailable] = useState(false);
  const [choice, setChoice] = useState(readAnalyticsConsent);
  const forced = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('analytics') === 'settings';

  useEffect(() => {
    if (!signedIn) {
      configureProductAnalytics(false);
      setAvailable(false);
      return;
    }
    let current = true;
    void apiFetch('/api/analytics/status').then((response) =>
      response.ok ? response.json() : { enabled: false }
    ).then((data: { enabled?: boolean }) => {
      if (!current) return;
      const enabled = data.enabled === true;
      setAvailable(enabled);
      configureProductAnalytics(enabled);
      if (enabled) trackProductEvent('editor_session_started');
    }).catch(() => {
      if (current) { configureProductAnalytics(false); setAvailable(false); }
    });
    return () => { current = false; configureProductAnalytics(false); };
  }, [signedIn]);

  if (!signedIn || !available || (choice !== 'unset' && !forced)) return null;

  const choose = (next: 'accepted' | 'declined') => {
    setAnalyticsConsent(next);
    setChoice(next);
    if (next === 'accepted') {
      configureProductAnalytics(true);
      trackProductEvent('editor_session_started');
    }
    if (forced) {
      const url = new URL(window.location.href);
      url.searchParams.delete('analytics');
      window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
    }
  };
  return (
    <Paper elevation={6} role="dialog" aria-label="Product analytics consent"
      sx={{ position: 'fixed', right: 16, bottom: 16, zIndex: 1800, p: 2, maxWidth: 340 }}>
      <Typography variant="subtitle2">Help improve Axoview?</Typography>
      <Typography variant="body2" sx={{ my: 1 }}>
        Allow first-party, anonymous feature-use statistics? No diagram text, prompts,
        account IDs or IP addresses are saved in these events. Optional, off by default.
      </Typography>
      <Typography variant="caption">
        <a href="/privacy" target="_blank" rel="noopener noreferrer">Privacy details</a>
      </Typography>
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, mt: 1 }}>
        <Button size="small" onClick={() => choose('declined')}>No thanks</Button>
        <Button size="small" variant="contained" onClick={() => choose('accepted')}>Allow</Button>
      </Box>
    </Paper>
  );
}
