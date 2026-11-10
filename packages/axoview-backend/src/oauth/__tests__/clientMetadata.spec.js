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

  it('the document must name itself, the client and https or loopback redirects; only public clients', () => {
    expect(clientFromDocument(CIMD, doc())).toEqual({
      client_id: CIMD, client_name: 'Claude Code', redirect_uris: ['http://localhost/callback'], registration: 'metadata'
    });
    expect(() => clientFromDocument(CIMD, doc({ client_id: 'https://evil.example/client.json' }))).toThrow(/does not match/);
    expect(() => clientFromDocument(CIMD, doc({ client_name: '' }))).toThrow(/client_name/);
    expect(() => clientFromDocument(CIMD, doc({ redirect_uris: ['http://evil.example/cb'] }))).toThrow(/redirect_uris/);
    expect(() => clientFromDocument(CIMD, doc({ token_endpoint_auth_method: 'client_secret_basic' }))).toThrow(/public clients/);
    expect(() => clientFromDocument(CIMD, 'not json')).toThrow(/not JSON/);
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
