import { getCognitoAccessToken } from '../stores/cognitoSessionStore';
import { getDeviceId } from './sync/deviceId';

/**
 * Same-origin AxoView API request with the current Cognito access token.
 * Writes also carry this tab's device id, so the realtime sync stream can tell
 * the tab which changes were its own (services/sync/realtimeSync.ts).
 */
export async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const token = await getCognitoAccessToken();
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const method = (init.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') headers.set('X-Axoview-Device', getDeviceId());
  return fetch(input, {
    ...init,
    headers,
    credentials: init.credentials || 'include'
  });
}
