import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Box, Button, CircularProgress, Typography } from '@mui/material';
import { useAppStorage } from './AppStorageContext';
import { dismissBootScreens } from '../utils/bootScreen';
import {
  beginCognitoSignIn,
  bootstrapCognitoSession,
  sessionEndedInOtherTab,
  signOutFromOtherTab,
  useCognitoSessionStore
} from '../stores/cognitoSessionStore';
import { onTabMessage, postToTabs } from '../services/sync/tabChannel';
import { signOutDriveFromOtherTab } from '../stores/authStore';

// Where to return after sign-in: a diagram link (/d/<id>?page=<view>) or an
// agent's consent page (/oauth/consent?request=<id>, ADR 0059) opened while
// signed out. Only those shapes are kept, so the stored value can never send
// the user anywhere else.
const RETURN_KEY = 'axoview-sign-in-return';
const RETURN_PATH = /^(\/d\/[A-Za-z0-9_-]{1,64}(\?page=[A-Za-z0-9_%.~!*'()-]{1,200})?|\/oauth\/consent\?request=[A-Za-z0-9_-]{24})$/;

export function rememberSignInReturn(path: string): void {
  try {
    if (RETURN_PATH.test(path)) sessionStorage.setItem(RETURN_KEY, path);
    else sessionStorage.removeItem(RETURN_KEY);
  } catch { /* storage unavailable: land on /app */ }
}

export function takeSignInReturn(): string {
  try {
    const path = sessionStorage.getItem(RETURN_KEY);
    sessionStorage.removeItem(RETURN_KEY);
    return path && RETURN_PATH.test(path) ? path : '/';
  } catch {
    return '/';
  }
}

export function CognitoSessionProvider({ children }: { children: React.ReactNode }) {
  const { runtimeConfig, isInitialized } = useAppStorage();
  const location = useLocation();
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  const sessionStatus = useCognitoSessionStore((state) => state.status);
  const user = useCognitoSessionStore((state) => state.user);
  const error = useCognitoSessionStore((state) => state.error);
  const config = runtimeConfig?.cognito || null;

  // The session is restored once per page load, and again only when this tab
  // arrives at /auth/callback. It used to run on every navigation
  // (location.key): each one swapped the whole app for the spinner below,
  // unmounting the editor, which then reloaded the diagram and wrote ?page=
  // back to the URL, which was another navigation. Every diagram open and
  // page switch blinked, and a diagram whose page id changed on each load
  // never stopped (dev, 2026-11-09). The access token refreshes on demand
  // (getCognitoAccessToken), so nothing needs a bootstrap per navigation.
  const onCallback = location.pathname.endsWith('/auth/callback');
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  useEffect(() => {
    if (!isInitialized) return;
    if (!config) {
      setReady(true);
      return;
    }
    let cancelled = false;
    void bootstrapCognitoSession(config).finally(() => {
      if (cancelled) return;
      setReady(true);
      if (window.location.pathname.endsWith('/auth/callback') && useCognitoSessionStore.getState().status === 'signed-in') {
        // Tabs left on the sign-in screen pick up the new session.
        postToTabs({ type: 'account-signed-in' });
        navigateRef.current(takeSignInReturn(), { replace: true });
      }
    });
    return () => { cancelled = true; };
  }, [config, isInitialized, onCallback]);

  // Other tabs of this browser (owner decision, 2026-11-10):
  // - signed in: every tab on the sign-in screen takes the session and goes
  //   to the app's home (/app), whatever link it was on;
  // - signed out, or the session expired: every tab goes to the landing page
  //   (cognitoSessionStore's signOutFromOtherTab / sessionEndedInOtherTab).
  useEffect(() => onTabMessage((message) => {
    if (message.type === 'account-signed-out') {
      void signOutFromOtherTab();
    } else if (message.type === 'account-session-ended') {
      sessionEndedInOtherTab();
    } else if (message.type === 'account-signed-in') {
      const { status } = useCognitoSessionStore.getState();
      // booting: this tab is finishing a sign-in of its own.
      if (!config || status === 'signed-in' || status === 'booting') return;
      void bootstrapCognitoSession(config).then(() => {
        if (useCognitoSessionStore.getState().status !== 'signed-in') return;
        rememberSignInReturn('');
        navigate('/', { replace: true });
      });
    } else if (message.type === 'drive-signed-out') {
      signOutDriveFromOtherTab();
    }
  }), [config, navigate]);

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

  // Signed out on a diagram link: come back to it after sign-in.
  useEffect(() => {
    if (showSignIn && !location.pathname.endsWith('/auth/callback')) {
      rememberSignInReturn(location.pathname + location.search);
    }
  }, [showSignIn, location.pathname, location.search]);

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
          {(config?.providers || []).map((provider) => (
            <Button
              key={provider}
              variant="outlined"
              fullWidth
              sx={{ mb: 1.5 }}
              onClick={() => void beginCognitoSignIn(config, provider)}
              data-axoview-id={`cognito-sign-in-${provider.toLowerCase()}`}
            >
              Continue with {provider}
            </Button>
          ))}
          <Button
            variant="contained"
            fullWidth={(config?.providers || []).length > 0}
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
