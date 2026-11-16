// Started with `node --import <this file> server.js` (see fakeCognito.hooks.mjs).
import { register } from 'node:module';
register('./fakeCognito.hooks.mjs', import.meta.url);
