import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Box, Button, CircularProgress, Typography } from '@mui/material';
import { useAppStorage } from './AppStorageContext';
import { dismissBootScreens } from '../utils/bootScreen';
import {
  beginCognitoSignIn,
  bootstrapCognitoSession,
  useCognitoSessionStore
} from '../stores/cognitoSessionStore';

export function CognitoSessionProvider({ children }: { children: React.ReactNode }) {
  const { runtimeConfig, isInitialized } = useAppStorage();
  const location = useLocation();
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  const sessionStatus = useCognitoSessionStore((state) => state.status);
  const user = useCognitoSessionStore((state) => state.user);
  const error = useCognitoSessionStore((state) => state.error);
  const config = runtimeConfig?.cognito || null;

  useEffect(() => {
    if (!isInitialized) return;
    if (!config) {
      setReady(true);
      return;
    }
    let cancelled = false;
    setReady(false);
    void bootstrapCognitoSession(config).finally(() => {
      if (cancelled) return;
      setReady(true);
      if (window.location.pathname.endsWith('/auth/callback') && useCognitoSessionStore.getState().status === 'signed-in') {
        navigate('/', { replace: true });
      }
    });
    return () => { cancelled = true; };
  }, [config, isInitialized, location.key, navigate]);

  const isPublicShare = location.pathname.startsWith('/display/p/');
  const showSignIn =
    isInitialized && ready && runtimeConfig?.authMode === 'cognito' && !user && !isPublicShare;

  // The boot splash (#ax-splash in app-shell.html, fixed and above everything)
  // is normally cleared by the editor shell. The sign-in screen replaces the
  // editor, so without this the splash stays on top of it forever and a
  // signed-out visitor only ever sees the loading spinner.
  useEffect(() => {
    if (showSignIn) dismissBootScreens();
  }, [showSignIn]);

  if (!isInitialized || !ready) {
    return <Box sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}><CircularProgress size={28} /></Box>;
  }

  if (showSignIn) {
    return (
      <Box sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center', p: 3 }}>
        <Box sx={{ width: '100%', maxWidth: 380, textAlign: 'center' }}>
          <Typography variant="h5" gutterBottom>
            {sessionStatus === 'error' ? 'Could not restore your session' : 'Sign in to AxoView'}
          </Typography>
          <Typography color="text.secondary" sx={{ mb: 2 }}>
            {sessionStatus === 'error'
              ? 'Sign in again to continue. Your diagrams stay private to your account.'
              : 'Your diagrams are saved to your account and stay private to you.'}
          </Typography>
          {error && <Typography color="error" role="alert" sx={{ mb: 2 }}>{error}</Typography>}
          <Button
            variant="contained"
            onClick={() => void beginCognitoSignIn(config)}
            data-axoview-id="cognito-sign-in"
          >
            Continue with email
          </Button>
        </Box>
      </Box>
    );
  }
  return <>{children}</>;
}
