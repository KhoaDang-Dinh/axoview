/** In-memory S3 and DynamoDB doubles for the AWS adapter (aws.js). */
import { BatchWriteCommand, TransactWriteCommand, DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
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
      if (command instanceof TransactWriteCommand) {
        for (const { Put: put } of input.TransactItems) {
          const current = rows.get(`${put.Item.PK}|${put.Item.SK}`);
          const failed = put.ConditionExpression === 'attribute_not_exists(PK)' ? !!current :
            put.ConditionExpression?.includes('#seq') && current && current.seq !== put.ExpressionAttributeValues[':previous'];
          if (failed) { const error = new Error('transaction condition'); error.name = 'TransactionCanceledException'; throw error; }
        }
        for (const { Put: put } of input.TransactItems) rows.set(`${put.Item.PK}|${put.Item.SK}`, put.Item);
        return {};
      }
      if (command instanceof BatchWriteCommand) {
        for (const requests of Object.values(input.RequestItems)) for (const request of requests) {
          const key = request.DeleteRequest.Key; rows.delete(`${key.PK}|${key.SK}`);
        }
        return {};
      }
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
        const inRange = input.KeyConditionExpression?.includes('BETWEEN')
          ? (sk) => sk >= (values[':from'] ?? values[':start']) && sk <= (values[':to'] ?? values[':end'])
          : values[':prefix'] !== undefined
            ? (sk) => sk.startsWith(values[':prefix'])
            : () => true;
        const Items = [...rows.values()]
          .filter((row) => row.PK === values[':pk'] && inRange(row.SK))
          .sort((a, b) => (a.SK < b.SK ? -1 : a.SK > b.SK ? 1 : 0))
          .slice(0, input.Limit ?? Infinity);
        return { Items };
      }
      // The sync cursor's bump: SET #change = :change ADD #seq :one.
      if (command instanceof UpdateCommand && input.UpdateExpression === 'SET #change = :change ADD #seq :one') {
        const current = rows.get(key) ?? { ...input.Key };
        const next = { ...current, change: input.ExpressionAttributeValues[':change'], seq: (current.seq || 0) + 1 };
        rows.set(key, next);
        return { Attributes: { change: next.change, seq: next.seq } };
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

