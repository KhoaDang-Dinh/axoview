/**
 * Who an OAuth client is (ADR 0059): Client ID Metadata Documents (fetched
 * within an SSRF fence) and DCR clients, redirect URI matching, PKCE.
 */
import { describe, it, expect } from '@jest/globals';
import {
  clientFromDocument, createClientResolver, isAcceptableRedirect, isMetadataUrl, isPrivateAddress, redirectMatches
} from '../clientMetadata.js';
import { pkceMatches, grantIdFor } from '../store.js';
import { sameResource } from '../router.js';
import crypto from 'crypto';

const CIMD = 'https://claude.example/oauth/client.json';
const doc = (fields = {}) => JSON.stringify({ client_id: CIMD, client_name: 'Claude Code', redirect_uris: ['http://localhost/callback'], ...fields });

describe('Client ID Metadata Documents', () => {
  it('a client_id is a metadata URL only when it is https, has a path, and names no IP, port or credentials', () => {
    expect(isMetadataUrl(CIMD)).toBe(true);
    for (const id of [
      'http://claude.example/client.json', 'https://claude.example', 'https://claude.example/',
      'https://10.0.0.1/client.json', 'https://[::1]/client.json', 'https://claude.example:8443/client.json',
      'https://user:pw@claude.example/client.json', 'https://claude.example/client.json#x', 'dcr_abc'
    ]) expect([id, isMetadataUrl(id)]).toEqual([id, false]);
  });

  it('the document must name itself, the client and https or loopback redirects', () => {
    expect(clientFromDocument(CIMD, doc())).toEqual({
      client_id: CIMD, client_name: 'Claude Code', redirect_uris: ['http://localhost/callback'], registration: 'metadata', tokenAuth: 'none'
    });
    expect(() => clientFromDocument(CIMD, doc({ client_id: 'https://evil.example/client.json' }))).toThrow(/does not match/);
    expect(() => clientFromDocument(CIMD, doc({ client_name: '' }))).toThrow(/client_name/);
    expect(() => clientFromDocument(CIMD, doc({ redirect_uris: ['http://evil.example/cb'] }))).toThrow(/redirect_uris/);
    expect(() => clientFromDocument(CIMD, doc({ token_endpoint_auth_method: 'client_secret_basic' })))
      .toThrow('the client authenticates with "client_secret_basic"; Axoview supports "none" and "private_key_jwt"');
    expect(() => clientFromDocument(CIMD, 'not json')).toThrow(/not JSON/);
  });

  describe('how the client authenticates at the token endpoint', () => {
    const KEYS = 'https://claude.example/oauth/jwks.json';
    const auth = (fields) => {
      const { tokenAuth, jwksUri, jwks, signingAlg } = clientFromDocument(CIMD, doc(fields));
      return { tokenAuth, jwksUri, jwks, signingAlg };
    };

    it('public when it says "none" or nothing (Claude, Claude Code)', () => {
      expect(auth({})).toEqual({ tokenAuth: 'none' });
      expect(auth({ token_endpoint_auth_method: 'none' })).toEqual({ tokenAuth: 'none' });
      expect(auth({ token_endpoint_auth_methods_supported: ['none'] })).toEqual({ tokenAuth: 'none' });
    });

    it('must sign when it offers only private_key_jwt (ChatGPT), with keys on its own origin', () => {
      expect(auth({ token_endpoint_auth_method: 'private_key_jwt', jwks_uri: KEYS }))
        .toEqual({ tokenAuth: 'private_key_jwt', jwksUri: KEYS });
      expect(auth({ token_endpoint_auth_methods_supported: ['private_key_jwt', 'client_secret_basic'], jwks_uri: KEYS, token_endpoint_auth_signing_alg: 'RS256' }))
        .toEqual({ tokenAuth: 'private_key_jwt', jwksUri: KEYS, signingAlg: 'RS256' });
      const jwks = { keys: [{ kty: 'EC', crv: 'P-256', x: 'x', y: 'y' }] };
      expect(auth({ token_endpoint_auth_method: 'private_key_jwt', jwks })).toEqual({ tokenAuth: 'private_key_jwt', jwks });
    });

    it('may go either way when it offers both: Axoview never requires a signature it could do without', () => {
      expect(auth({ token_endpoint_auth_method: 'private_key_jwt', token_endpoint_auth_methods_supported: ['private_key_jwt', 'none'], jwks_uri: KEYS }))
        .toEqual({ tokenAuth: 'none', jwksUri: KEYS });
      // Without keys it can only be public.
      expect(auth({ token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'] })).toEqual({ tokenAuth: 'none' });
    });

    it('refuses what it cannot check', () => {
      const refused = (fields) => () => clientFromDocument(CIMD, doc(fields));
      expect(refused({ token_endpoint_auth_method: 'private_key_jwt' })).toThrow(/needs a jwks_uri/);
      expect(refused({ token_endpoint_auth_method: 'private_key_jwt', jwks_uri: 'https://evil.example/jwks.json' })).toThrow(/own origin/);
      expect(refused({ token_endpoint_auth_method: 'private_key_jwt', jwks_uri: 'http://claude.example/jwks.json' })).toThrow(/own origin/);
      expect(refused({ token_endpoint_auth_method: 'private_key_jwt', jwks: { keys: [] } })).toThrow(/1 to 10 keys/);
      expect(refused({ token_endpoint_auth_method: 'private_key_jwt', jwks_uri: KEYS, token_endpoint_auth_signing_alg: 'HS256' })).toThrow(/signing_alg/);
      expect(refused({ token_endpoint_auth_methods_supported: 'none' })).toThrow(/list of strings/);
      expect(refused({ token_endpoint_auth_method: 7 })).toThrow(/not a string/);
      expect(refused({ token_endpoint_auth_methods_supported: ['client_secret_post', 'tls_client_auth'] }))
        .toThrow('the client authenticates with "client_secret_post", "tls_client_auth"; Axoview supports "none" and "private_key_jwt"');
    });
  });

  it('fetches once and caches for the max-age asked, at least a minute', async () => {
    let clock = 0;
    const fetched = [];
    const resolve = createClientResolver({
      registeredClient: async () => null,
      fetchDocument: async (url) => { fetched.push(url); return { body: doc(), maxAgeMs: 0 }; },
      now: () => clock
    });
    await resolve(CIMD);
    clock = 59_000;
    await resolve(CIMD);
    expect(fetched).toHaveLength(1);
    clock = 61_000;
    await resolve(CIMD);
    expect(fetched).toHaveLength(2);
  });

  it('DCR ids come from the store; anything else is an unknown client', async () => {
    const resolve = createClientResolver({
      registeredClient: async (id) => (id === `dcr_${'a'.repeat(32)}` ? { client_id: id, client_name: 'Codex', redirect_uris: [] } : null),
      fetchDocument: async () => { throw new Error('no fetch for DCR ids'); }
    });
    await expect(resolve(`dcr_${'a'.repeat(32)}`)).resolves.toMatchObject({ client_name: 'Codex', registration: 'dynamic' });
    await expect(resolve(`dcr_${'b'.repeat(32)}`)).rejects.toThrow(/unknown client_id/);
    await expect(resolve('../../etc/passwd')).rejects.toThrow(/unknown client_id/);
  });
});

describe('the SSRF fence', () => {
  it('refuses private, loopback, link-local, CGNAT and multicast addresses', () => {
    for (const address of ['10.1.2.3', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
      expect([address, isPrivateAddress(address)]).toEqual([address, true]);
    }
    for (const address of ['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111']) {
      expect([address, isPrivateAddress(address)]).toEqual([address, false]);
    }
  });
});

describe('redirect URIs', () => {
  it('https or loopback http, no fragments', () => {
    expect(isAcceptableRedirect('https://chatgpt.example/cb')).toBe(true);
    expect(isAcceptableRedirect('http://127.0.0.1:3000/cb')).toBe(true);
    expect(isAcceptableRedirect('http://example.com/cb')).toBe(false);
    expect(isAcceptableRedirect('https://example.com/cb#x')).toBe(false);
    expect(isAcceptableRedirect('javascript:alert(1)')).toBe(false);
  });

  it('exact, except a loopback redirect may use any port', () => {
    const registered = ['http://127.0.0.1/callback', 'https://claude.example/cb'];
    expect(redirectMatches(registered, 'https://claude.example/cb')).toBe(true);
    expect(redirectMatches(registered, 'https://claude.example/cb?x=1')).toBe(false);
    expect(redirectMatches(registered, 'http://127.0.0.1:54321/callback')).toBe(true);
    expect(redirectMatches(registered, 'http://127.0.0.1:54321/other')).toBe(false);
    expect(redirectMatches(registered, 'http://localhost:54321/callback')).toBe(false);
  });
});

describe('tokens', () => {
  it('PKCE S256 with a 43-128 character verifier', () => {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    expect(pkceMatches(verifier, challenge)).toBe(true);
    expect(pkceMatches(`${verifier}x`, challenge)).toBe(false);
    expect(pkceMatches('short', challenge)).toBe(false);
  });

  it('the resource matches tolerating case in scheme and host and a trailing slash', () => {
    expect(sameResource('HTTPS://Axoview.example/api/mcp/workspace/', 'https://axoview.example/api/mcp/workspace')).toBe(true);
    expect(sameResource('https://axoview.example/api/mcp', 'https://axoview.example/api/mcp/workspace')).toBe(false);
    expect(sameResource('https://other.example/api/mcp/workspace', 'https://axoview.example/api/mcp/workspace')).toBe(false);
  });

  it('one grant per person and client', () => {
    expect(grantIdFor('alice', 'c1')).toBe(grantIdFor('alice', 'c1'));
    expect(grantIdFor('alice', 'c1')).not.toBe(grantIdFor('bob', 'c1'));
  });
});
