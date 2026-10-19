import { getCognitoAccessToken } from '../stores/cognitoSessionStore';

/** Same-origin AxoView API request with the current Cognito access token. */
export async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const token = await getCognitoAccessToken();
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(input, {
    ...init,
    headers,
    credentials: init.credentials || 'include'
  });
}
