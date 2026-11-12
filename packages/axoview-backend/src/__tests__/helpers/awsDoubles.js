/** In-memory S3 and DynamoDB doubles for the AWS adapter (aws.js). */
import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand
} from '@aws-sdk/client-s3';
export function makeAwsDoubles() {
  const rows = new Map();
  const objects = new Map();
  // Every command sent, by name (GetCommand, PutObjectCommand, ...): what a
  // request costs in DynamoDB and S3 calls.
  const calls = [];
  const ddbClient = {
    async send(command) {
      calls.push(command.constructor.name);
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
      calls.push(command.constructor.name);
      const input = command.input;
      if (command instanceof PutObjectCommand) {
        if (input.IfNoneMatch === '*' && objects.has(input.Key)) {
          const error = new Error('At least one of the pre-conditions you specified did not hold');
          error.name = 'PreconditionFailed';
          error.$metadata = { httpStatusCode: 412 };
          throw error;
        }
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
  /** The calls made by `fn`, counted by command name. */
  async function count(fn) {
    const from = calls.length;
    await fn();
    const counts = {};
    for (const name of calls.slice(from)) counts[name] = (counts[name] || 0) + 1;
    return counts;
  }
  return { ddbClient, s3Client, rows, objects, calls, count };
}

