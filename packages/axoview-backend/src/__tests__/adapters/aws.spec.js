import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand
} from '@aws-sdk/client-s3';
import { createAwsWorkspaceAdapter } from '../../adapters/aws.js';

function makeAwsDoubles() {
  const rows = new Map();
  const objects = new Map();
  const ddbClient = {
    async send(command) {
      const input = command.input;
      const key = `${input.Key?.PK}|${input.Key?.SK}`;
      if (command instanceof GetCommand) return { Item: rows.get(key) };
      if (command instanceof PutCommand) {
        const current = rows.get(`${input.Item.PK}|${input.Item.SK}`);
        if (input.ConditionExpression === 'attribute_not_exists(PK)' && current) {
          const error = new Error('condition'); error.name = 'ConditionalCheckFailedException'; throw error;
        }
        if (input.ConditionExpression?.includes('#version') && current?.version !== input.ExpressionAttributeValues[':expectedVersion']) {
          const error = new Error('condition'); error.name = 'ConditionalCheckFailedException'; throw error;
        }
        if (input.ConditionExpression?.includes('workspaceId =') && current && current.workspaceId !== input.ExpressionAttributeValues[':workspaceId']) {
          const error = new Error('condition'); error.name = 'ConditionalCheckFailedException'; throw error;
        }
        rows.set(`${input.Item.PK}|${input.Item.SK}`, input.Item);
        return {};
      }
      if (command instanceof DeleteCommand) {
        const current = rows.get(key);
        if (input.ConditionExpression?.includes('#version') && current?.version !== input.ExpressionAttributeValues[':expectedVersion']) {
          const error = new Error('condition'); error.name = 'ConditionalCheckFailedException'; throw error;
        }
        if (input.ConditionExpression?.includes('workspaceId =') && current?.workspaceId !== input.ExpressionAttributeValues[':workspaceId']) {
          const error = new Error('condition'); error.name = 'ConditionalCheckFailedException'; throw error;
        }
        rows.delete(key);
        return {};
      }
      if (command instanceof QueryCommand) {
        const values = input.ExpressionAttributeValues;
        const Items = [...rows.values()].filter((row) => row.PK === values[':pk'] && row.SK.startsWith(values[':prefix']));
        return { Items };
      }
      throw new Error(`Unexpected DynamoDB command: ${command.constructor.name}`);
    }
  };
  const s3Client = {
    async send(command) {
      const input = command.input;
      if (command instanceof PutObjectCommand) {
        objects.set(input.Key, new Uint8Array(input.Body));
        return {};
      }
      if (command instanceof GetObjectCommand) {
        const body = objects.get(input.Key);
        if (!body) {
          const error = new Error('missing'); error.name = 'NoSuchKey'; throw error;
        }
        return { Body: { transformToByteArray: async () => new Uint8Array(body) } };
      }
      if (command instanceof DeleteObjectCommand) {
        objects.delete(input.Key);
        return {};
      }
      if (command instanceof ListObjectsV2Command) {
        return { Contents: [...objects.keys()].filter((key) => key.startsWith(input.Prefix)).map((Key) => ({ Key })) };
      }
      throw new Error(`Unexpected S3 command: ${command.constructor.name}`);
    }
  };
  return { ddbClient, s3Client, rows, objects };
}

const asBytes = (value) => new TextEncoder().encode(JSON.stringify(value));
const asJson = (value) => JSON.parse(new TextDecoder().decode(value));

describe('AWS workspace storage adapter', () => {
  test('keeps diagram metadata and bodies isolated by workspace', async () => {
    const doubles = makeAwsDoubles();
    const alice = createAwsWorkspaceAdapter({ workspaceId: 'alice', bucketName: 'data', tableName: 'app', ...doubles });
    const bob = createAwsWorkspaceAdapter({ workspaceId: 'bob', bucketName: 'data', tableName: 'app', ...doubles });

    await alice.put('diagrams/d1', asBytes({ id: 'd1', title: 'Alice diagram', lastModified: 'now' }));
    expect(asJson(await alice.get('diagrams/d1')).title).toBe('Alice diagram');
    expect(await bob.get('diagrams/d1')).toBeNull();
    expect(await bob.listDiagramMeta()).toEqual([]);
    expect(await alice.listDiagramMeta()).toEqual([
      { id: 'd1', name: 'Alice diagram', lastModified: 'now', folderId: null, deletedAt: null, version: 1 }
    ]);
    expect([...doubles.objects.keys()][0]).toMatch(/^workspaces\/alice\/diagrams\/d1\//);
  });

  test('conditional metadata writes reject an old version after a competing save', async () => {
    const doubles = makeAwsDoubles();
    const adapter = createAwsWorkspaceAdapter({ workspaceId: 'alice', bucketName: 'data', tableName: 'app', ...doubles });
    await adapter.put('diagrams/d1', asBytes({ id: 'd1', title: 'initial' }));
    const staleVersion = await adapter.getDiagramVersion('d1');
    await adapter.put('diagrams/d1', asBytes({ id: 'd1', title: 'new save' }), { expectedVersion: staleVersion });
    await expect(adapter.put(
      'diagrams/d1',
      asBytes({ id: 'd1', title: 'stale save' }),
      { expectedVersion: staleVersion }
    )).rejects.toMatchObject({ status: 409, body: { code: 'VERSION_CONFLICT' } });
    expect(asJson(await adapter.get('diagrams/d1')).title).toBe('new save');
  });

  test('public snapshots resolve through the global share index but remain scoped to their owner', async () => {
    const doubles = makeAwsDoubles();
    const alice = createAwsWorkspaceAdapter({ workspaceId: 'alice', bucketName: 'data', tableName: 'app', ...doubles });
    const bob = createAwsWorkspaceAdapter({ workspaceId: 'bob', bucketName: 'data', tableName: 'app', ...doubles });
    await alice.put('public/abcdefghijklmnopqrstu', asBytes({ title: 'shared' }));
    expect(asJson(await bob.get('public/abcdefghijklmnopqrstu'))).toEqual({ title: 'shared' });
    await bob.delete('public/abcdefghijklmnopqrstu');
    expect(asJson(await alice.get('public/abcdefghijklmnopqrstu'))).toEqual({ title: 'shared' });
  });
});
