/**
 * Module hooks for server tests that need signed-in people without Cognito:
 * the child server is started with `--import <fakeCognito.register.mjs>`.
 *   - src/cognitoAuth.js: an access token "test-user:<sub>" is that person.
 *   - src/cognitoDirectory.js: accounts come from FAKE_COGNITO_ACCOUNTS, a
 *     JSON array of { sub, email, email_verified, enabled? }.
 * Test-only: nothing in the product reads these.
 */
const AUTH = `
export async function verifyCognitoAccessToken(token) {
  const match = /^test-user:([A-Za-z0-9-]{1,128})$/.exec(token || '');
  if (!match) throw new Error('bad test token');
  return { sub: match[1], username: match[1] };
}
export function clearCognitoJwksCacheForTests() {}
`;

const DIRECTORY = `
const accounts = JSON.parse(process.env.FAKE_COGNITO_ACCOUNTS || '[]');
const ok = (a) => a && a.email_verified === true && a.enabled !== false;
export function createCognitoDirectory() {
  return {
    async findUserByEmail(email) {
      const a = accounts.find((x) => x.email.toLowerCase() === email && ok(x));
      return a ? { sub: a.sub, email: a.email.toLowerCase() } : null;
    },
    async findUserBySub(sub) {
      const a = accounts.find((x) => x.sub === sub && ok(x));
      return a ? { sub: a.sub, email: a.email.toLowerCase() } : null;
    }
  };
}
`;

export async function load(url, context, nextLoad) {
  if (url.endsWith('/axoview-backend/src/cognitoAuth.js')) {
    return { format: 'module', source: AUTH, shortCircuit: true };
  }
  if (url.endsWith('/axoview-backend/src/cognitoDirectory.js')) {
    return { format: 'module', source: DIRECTORY, shortCircuit: true };
  }
  return nextLoad(url, context);
}
