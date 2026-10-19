import { HttpError } from './routes.js';
import { verifyCognitoAccessToken } from './cognitoAuth.js';

const COOKIE_NAME = 'axoview_refresh';
const REFRESH_COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

function cognitoConfig(env) {
  const { COGNITO_REGION: region, COGNITO_ISSUER: issuer, COGNITO_USER_POOL_ID: userPoolId, COGNITO_CLIENT_ID: clientId, COGNITO_DOMAIN: domain, PUBLIC_BASE_URL: baseUrl } = env || {};
  if ((!region && !issuer) || !userPoolId || !clientId || !domain || !baseUrl) {
    throw new HttpError(503, 'Sign-in is not configured');
  }
  let parsed;
  try { parsed = new URL(domain); } catch { throw new HttpError(503, 'Sign-in is not configured'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new HttpError(503, 'Sign-in is not configured');
  }
  return {
    region,
    issuer,
    userPoolId,
    clientId,
    tokenUrl: `${parsed.origin}/oauth2/token`,
    revokeUrl: `${parsed.origin}/oauth2/revoke`,
    redirectUri: `${String(baseUrl).replace(/\/+$/, '')}/app/auth/callback`
  };
}

function cookieHeader(refreshToken, production) {
  const attrs = [
    `${COOKIE_NAME}=${encodeURIComponent(refreshToken)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/api/auth',
    `Max-Age=${REFRESH_COOKIE_MAX_AGE}`
  ];
  if (production) attrs.push('Secure');
  return attrs.join('; ');
}

function clearCookieHeader(production) {
  const attrs = [`${COOKIE_NAME}=`, 'HttpOnly', 'SameSite=Lax', 'Path=/api/auth', 'Max-Age=0'];
  if (production) attrs.push('Secure');
  return attrs.join('; ');
}

async function postForm(url, fields, fetchImpl = fetch) {
  return fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(fields),
    signal: AbortSignal.timeout(8000)
  });
}

async function tokenResult(response, config) {
  if (!response.ok) throw new HttpError(401, 'Sign-in failed');
  const body = await response.json();
  const user = await verifyCognitoAccessToken(body.access_token, {
    region: config.region,
    userPoolId: config.userPoolId,
    clientId: config.clientId,
    issuer: config.issuer
  });
  if (!Number.isFinite(body.expires_in) || body.expires_in <= 0) {
    throw new HttpError(401, 'Sign-in failed');
  }
  const result = {
    status: 200,
    body: { accessToken: body.access_token, expiresIn: body.expires_in, user }
  };
  if (body.refresh_token) {
    result.headers = {
      'Set-Cookie': cookieHeader(body.refresh_token, process.env.NODE_ENV === 'production')
    };
  }
  return result;
}

export async function exchangeCognitoCode(_adapter, ctx) {
  const config = cognitoConfig(ctx.env);
  const { code, codeVerifier } = ctx.body || {};
  if (typeof code !== 'string' || code.length > 4096 || typeof codeVerifier !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(codeVerifier)) {
    throw new HttpError(400, 'Invalid sign-in response');
  }
  let response;
  try {
    response = await postForm(config.tokenUrl, {
      grant_type: 'authorization_code',
      client_id: config.clientId,
      code,
      redirect_uri: config.redirectUri,
      code_verifier: codeVerifier
    });
  } catch {
    throw new HttpError(502, 'Sign-in service unavailable');
  }
  return tokenResult(response, config);
}

export async function refreshCognitoSession(_adapter, ctx) {
  const config = cognitoConfig(ctx.env);
  const refreshToken = ctx.refreshToken;
  if (typeof refreshToken !== 'string' || refreshToken.length > 8192) {
    throw new HttpError(401, 'Session expired');
  }
  let response;
  try {
    response = await postForm(config.tokenUrl, {
      grant_type: 'refresh_token',
      client_id: config.clientId,
      refresh_token: refreshToken
    });
  } catch {
    throw new HttpError(502, 'Sign-in service unavailable');
  }
  return tokenResult(response, config);
}

export async function revokeCognitoSession(_adapter, ctx) {
  let status = 204;
  try {
    const config = cognitoConfig(ctx.env);
    if (typeof ctx.refreshToken === 'string' && ctx.refreshToken.length <= 8192) {
      const response = await postForm(config.revokeUrl, {
        client_id: config.clientId,
        token: ctx.refreshToken
      });
      if (!response.ok) status = 502;
    }
  } catch {
    // Clear the browser session even when Cognito is temporarily unreachable.
    status = 204;
  }
  return {
    status,
    body: { success: status === 204 },
    headers: { 'Set-Cookie': clearCookieHeader(process.env.NODE_ENV === 'production') }
  };
}

export const cognitoRefreshCookieName = COOKIE_NAME;
