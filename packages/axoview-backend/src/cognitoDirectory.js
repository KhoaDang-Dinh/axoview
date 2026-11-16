/**
 * Finding an account in the Cognito user pool, for sharing by email (ADR 0057
 * §5): ListUsers with an exact attribute filter, run by the API with its own
 * IAM permission (cognito-idp:ListUsers on the pool; infra_website grants it).
 *
 * Only an account whose email is VERIFIED matches. Otherwise someone could
 * register an unverified account with another person's address and receive
 * what was shared with them (the same rule as account linking). Disabled
 * accounts never match.
 */
import {
  CognitoIdentityProviderClient,
  ListUsersCommand
} from '@aws-sdk/client-cognito-identity-provider';

const attribute = (user, name) => user.Attributes?.find((a) => a.Name === name)?.Value;

/** A ListUsers user -> { sub, email } when it may receive shares, else null. */
export function sharableUser(user) {
  if (!user || user.Enabled === false) return null;
  const sub = attribute(user, 'sub');
  const email = attribute(user, 'email');
  if (!sub || !email || attribute(user, 'email_verified') !== 'true') return null;
  return { sub, email: email.toLowerCase() };
}

/**
 * @param {{ userPoolId: string, region: string, client?: { send: Function } }} options
 */
export function createCognitoDirectory({ userPoolId, region, client }) {
  const cognito = client || new CognitoIdentityProviderClient({ region });

  async function findBy(name, value) {
    // The value never holds a double quote or backslash: normalizeEmail
    // (src/sharing.js) and the JWT sub pattern rule them out.
    const result = await cognito.send(new ListUsersCommand({
      UserPoolId: userPoolId,
      Filter: `${name} = "${value}"`,
      Limit: 10
    }));
    // Federated sign-ins (Google) and a password account can share an email
    // until they are linked: any verified, enabled one is the person.
    for (const user of result.Users || []) {
      const found = sharableUser(user);
      if (found) return found;
    }
    return null;
  }

  return {
    findUserByEmail: (email) => findBy('email', email),
    findUserBySub: (sub) => findBy('sub', sub)
  };
}
