/**
 * Started with `node --import <this file> server.js` next to
 * STORAGE_ADAPTER=aws: the server runs the real AWS adapter and DynamoDB sync
 * cursor against in-memory S3 and DynamoDB (awsDoubles.js), so a test can
 * exercise versioned storage (If-Match, ETags, conditional writes) without
 * AWS. Test-only: nothing in the product reads this.
 */
import { register } from 'node:module';
import { makeAwsDoubles } from './awsDoubles.js';

globalThis.__axoviewFakeAws = makeAwsDoubles();
register('./fakeAws.hooks.mjs', import.meta.url);
