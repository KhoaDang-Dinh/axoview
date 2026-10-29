import { externalIdentityProviders, getConfig } from '../routes.js';
import { makeCtx } from './helpers/memoryAdapter.js';

describe('getConfig', () => {
  test('returns documented shape with defaults when env is empty', () => {
    const result = getConfig(null, makeCtx({ env: {} }));
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      googleClientId: null,
      drivePublicPreview: false,
      googleProjectNumber: null,
      driveScopes: ['https://www.googleapis.com/auth/drive.file'],
      authMode: 'none',
      cognito: null,
      serverStorage: true,
      publicBaseUrl: null,
      ai: {
        chatEnabled: false,
        guestEnabled: false,
        diagramContextEnabled: false,
        mcpEnabled: false,
        ragEnabled: false,
        agentWriteEnabled: false
      }
    });
  });

  // A5/CHR-08 (owner ruling 2026-07-30): the client's own link builders resolve
  // against this when the operator configures one, so a preview/staging/LAN
  // origin cannot leak into a durable share link. Null keeps the page origin.
  test('AI flags require the exact true string and default to false', () => {
    const flags = getConfig(null, makeCtx({ env: {
      AI_CHAT_ENABLED: 'true', AI_GUEST_ENABLED: 'TRUE',
      AI_MCP_ENABLED: 'true', AI_RAG_ENABLED: true
    }})).body.ai;
    expect(flags).toEqual({
      chatEnabled: true, guestEnabled: false, diagramContextEnabled: false,
      mcpEnabled: true, ragEnabled: false, agentWriteEnabled: false
    });
  });

  test('surfaces PUBLIC_BASE_URL so the app can mint canonical links', () => {
    const result = getConfig(
      null,
      makeCtx({ env: { PUBLIC_BASE_URL: 'https://diagrams.example.com' } })
    );
    expect(result.body.publicBaseUrl).toBe('https://diagrams.example.com');
  });

  test('reflects GOOGLE_CLIENT_ID + AUTH_MODE from env', () => {
    const result = getConfig(
      null,
      makeCtx({
        env: { GOOGLE_CLIENT_ID: 'client-123', AUTH_MODE: 'shared-token' }
      })
    );
    expect(result.body.googleClientId).toBe('client-123');
    expect(result.body.authMode).toBe('shared-token');
  });

  test('drivePublicPreview is always false (no proxy on Docker/Express) + no raw key surfaced (ADR 0042 §8)', () => {
    const result = getConfig(
      null,
      makeCtx({
        env: { GOOGLE_API_KEY: 'AIza-test-key', GOOGLE_PROJECT_NUMBER: '123456789012' }
      })
    );
    expect(result.body.drivePublicPreview).toBe(false);
    expect(result.body.googleApiKey).toBeUndefined();
    expect(result.body.googleProjectNumber).toBe('123456789012');
  });

  test('serverStorage is true unless STORAGE_ENABLED is explicitly false', () => {
    expect(getConfig(null, makeCtx({ env: { STORAGE_ENABLED: false } })).body.serverStorage).toBe(false);
    expect(getConfig(null, makeCtx({ env: { STORAGE_ENABLED: true } })).body.serverStorage).toBe(true);
    expect(getConfig(null, makeCtx({ env: {} })).body.serverStorage).toBe(true);
  });

  test('cognito config lists external sign-in providers, never COGNITO itself', () => {
    const cognitoEnv = {
      AUTH_MODE: 'cognito',
      COGNITO_DOMAIN: 'https://axoview-dev-1.auth.ap-southeast-1.amazoncognito.com',
      COGNITO_CLIENT_ID: 'client',
      PUBLIC_BASE_URL: 'https://dev.example.com'
    };
    const withGoogle = getConfig(null, makeCtx({ env: { ...cognitoEnv, COGNITO_IDENTITY_PROVIDERS: 'COGNITO,Google' } }));
    expect(withGoogle.body.cognito).toEqual({
      domain: 'https://axoview-dev-1.auth.ap-southeast-1.amazoncognito.com',
      clientId: 'client',
      redirectUri: 'https://dev.example.com/app/auth/callback',
      logoutUri: 'https://dev.example.com/',
      providers: ['Google'],
      mobile: null
    });
    expect(getConfig(null, makeCtx({ env: cognitoEnv })).body.cognito.providers).toEqual([]);
  });

  test('cognito config carries the mobile app client and its custom-scheme redirect', () => {
    const env = {
      AUTH_MODE: 'cognito',
      COGNITO_DOMAIN: 'https://axoview-prod-1.auth.ap-southeast-1.amazoncognito.com',
      COGNITO_CLIENT_ID: 'web-client',
      PUBLIC_BASE_URL: 'https://example.com',
      COGNITO_MOBILE_CLIENT_ID: 'mobile-client',
      COGNITO_MOBILE_REDIRECT_URI: 'axoview://auth/callback'
    };
    expect(getConfig(null, makeCtx({ env })).body.cognito.mobile).toEqual({
      clientId: 'mobile-client',
      redirectUri: 'axoview://auth/callback',
      logoutUri: 'axoview://auth/logout'
    });
    // Only a custom scheme with the fixed path is published.
    for (const bad of ['https://example.com/auth/callback', 'javascript://auth/callback', 'axoview://evil/callback', 'axoview://auth/callback?x=1']) {
      expect(getConfig(null, makeCtx({ env: { ...env, COGNITO_MOBILE_REDIRECT_URI: bad } })).body.cognito.mobile).toBeNull();
    }
    expect(getConfig(null, makeCtx({ env: { ...env, COGNITO_MOBILE_CLIENT_ID: '' } })).body.cognito.mobile).toBeNull();
  });

  test('externalIdentityProviders keeps only plain provider names', () => {
    expect(externalIdentityProviders('COGNITO, Google ,Google,Facebook')).toEqual(['Google', 'Facebook']);
    expect(externalIdentityProviders('Google&evil=1,<script>,,cognito')).toEqual([]);
    expect(externalIdentityProviders(undefined)).toEqual([]);
  });

  test('survives null ctx', () => {
    const result = getConfig(null, null);
    expect(result.status).toBe(200);
    expect(result.body.authMode).toBe('none');
  });
});
