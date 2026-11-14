/**
 * Module hooks for fakeAws.register.mjs: where the AWS adapter and the sync
 * cursor would build real S3 and DynamoDB clients, they take the in-memory
 * doubles instead. Everything else in those modules is the shipped code.
 */
const SWAPS = {
  '/axoview-backend/src/collaboration.js': [
    ['ddbClient || tableName && DynamoDBDocumentClient.from(', 'ddbClient || globalThis.__axoviewFakeAws.ddbClient || tableName && DynamoDBDocumentClient.from(']
  ],
  '/axoview-backend/src/adapters/aws.js': [
    ['s3Client || new S3Client({ region })', 's3Client || globalThis.__axoviewFakeAws.s3Client'],
    ['ddbClient || DynamoDBDocumentClient.from(', 'ddbClient || globalThis.__axoviewFakeAws.ddbClient || DynamoDBDocumentClient.from(']
  ],
  '/axoview-backend/src/syncCursor.js': [
    ['ddbClient || DynamoDBDocumentClient.from(', 'ddbClient || globalThis.__axoviewFakeAws.ddbClient || DynamoDBDocumentClient.from(']
  ]
};

export async function load(url, context, nextLoad) {
  const swaps = Object.entries(SWAPS).find(([suffix]) => url.endsWith(suffix))?.[1];
  const result = await nextLoad(url, context);
  if (!swaps) return result;
  let source = String(result.source);
  for (const [from, to] of swaps) {
    if (!source.includes(from)) throw new Error(`fakeAws: ${url} no longer contains "${from}"`);
    source = source.split(from).join(to);
  }
  return { ...result, source, shortCircuit: true };
}
