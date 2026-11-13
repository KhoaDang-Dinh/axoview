import { afterEach, describe, expect, it, jest } from '@jest/globals';
import dns from 'dns';
import net from 'net';
import { safeLookup } from '../clientMetadata.js';

afterEach(() => jest.restoreAllMocks());

describe('CIMD DNS lookup callback contract', () => {
  it('returns every public address when Node requests all:true', () => {
    const addresses = [{ address: '93.184.216.34', family: 4 }, { address: '2606:4700:4700::1111', family: 6 }];
    const lookup = jest.spyOn(dns, 'lookup').mockImplementation((host, options, callback) => {
      expect(options.all).toBe(true);
      callback(null, addresses);
    });
    const callback = jest.fn();
    safeLookup('metadata.example', { all: true }, callback);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(null, addresses);
  });

  it('preserves the single-address callback for all:false', () => {
    jest.spyOn(dns, 'lookup').mockImplementation((host, options, callback) => callback(null, '93.184.216.34', 4));
    const callback = jest.fn();
    safeLookup('metadata.example', { all: false, family: 4 }, callback);
    expect(callback).toHaveBeenCalledWith(null, '93.184.216.34', 4);
  });

  it.each(['10.0.0.1', '127.0.0.1', '169.254.169.254', '::1', 'fd00::1'])(
    'rejects a mixed answer containing %s', (address) => {
      jest.spyOn(dns, 'lookup').mockImplementation((host, options, callback) => callback(null, [
        { address: '93.184.216.34', family: 4 }, { address, family: net.isIP(address) }
      ]));
      const callback = jest.fn();
      safeLookup('metadata.example', { all: true }, callback);
      expect(callback).toHaveBeenCalledWith(expect.any(Error));
    }
  );

  it('rejects an empty answer', () => {
    jest.spyOn(dns, 'lookup').mockImplementation((host, options, callback) => callback(null, []));
    const callback = jest.fn();
    safeLookup('metadata.example', { all: true }, callback);
    expect(callback).toHaveBeenCalledWith(expect.any(Error));
  });

  it('passes DNS failures back without converting them to successful answers', () => {
    const error = new Error('DNS failed');
    jest.spyOn(dns, 'lookup').mockImplementation((host, options, callback) => callback(error));
    const callback = jest.fn();
    safeLookup('metadata.example', { all: true }, callback);
    expect(callback).toHaveBeenCalledWith(error);
  });

  it('satisfies the real Node family-autoselection contract before connecting', async () => {
    jest.spyOn(dns, 'lookup').mockImplementation((host, options, callback) => {
      expect(options.all).toBe(true);
      callback(null, [{ address: '93.184.216.34', family: 4 }]);
    });
    // Destroy on the lookup event: exercise Node's contract without network I/O.
    await new Promise((resolve, reject) => {
      const socket = new net.Socket();
      socket.once('lookup', (error, address, family) => {
        try {
          expect(error).toBe(null);
          expect(address).toBe('93.184.216.34');
          expect(family).toBe(4);
          socket.destroy();
          resolve();
        } catch (failure) {
          socket.destroy();
          reject(failure);
        }
      });
      socket.once('error', reject);
      socket.connect({ host: 'metadata.example', port: 443, autoSelectFamily: true, lookup: safeLookup });
    });
  });
});
