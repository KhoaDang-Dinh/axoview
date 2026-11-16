import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand
} from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';

import { contentHash, pickServerOwned } from '../diagramContent.js';

const WORKSPACE_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const DIAGRAM_KEY_RE = /^diagrams\/([A-Za-z0-9_-]{1,64})$/;
const PUBLIC_KEY_RE = /^public\/([A-Za-z0-9_-]{21,64})$/;

function assertWorkspaceId(value) {
  if (typeof value !== 'string' || !WORKSPACE_PATTERN.test(value)) {
    throw new Error('Invalid trusted workspace id');
  }
  return value;
}

function decodeJson(bytes) {
  if (!bytes) return null;
  return JSON.parse(new TextDecoder().decode(bytes));
}

/**
 * `currentVersion`, when this request already knows it: the client can retry
 * against it without downloading the diagram just to learn its version.
 */
function conflictError(currentVersion) {
  const error = new Error('Diagram changed elsewhere. Reload before saving.');
  error.status = 409;
  error.body = {
    error: error.message,
    code: 'VERSION_CONFLICT',
    ...(typeof currentVersion === 'number' ? { currentVersion } : {})
  };
  return error;
}

function preconditionError() {
  const error = new Error('Reload this diagram before saving.');
  error.status = 428;
  error.body = { error: error.message, code: 'IF_MATCH_REQUIRED' };
  return error;
}

async function bodyBytes(body) {
  if (!body) return null;
  return new Uint8Array(await body.transformToByteArray());
}

function createClients({ s3Client, ddbClient, region }) {
  const s3 = s3Client || new S3Client({ region });
  const ddb = ddbClient || DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
    marshallOptions: { removeUndefinedValues: true }
  });
  return { s3, ddb };
}

/**
 * Production ObjectStorage backed by S3 object bodies and a DynamoDB metadata
 * index. `workspaceId` must be selected by trusted application code after
 * verifying the user's identity/membership. Diagram writes use immutable S3
 * object keys and a conditional DynamoDB pointer update, so a save based on an
 * outdated version is refused (409) even when API pods do not share memory.
 * The app resolves that as "latest save wins" (multi-device sync): it learns
 * the current version and saves again, deliberately replacing it.
 */
export function createAwsWorkspaceAdapter({
  workspaceId,
  bucketName,
  tableName,
  region,
  s3Client,
  ddbClient
}) {
  assertWorkspaceId(workspaceId);
  if (!bucketName || !tableName) throw new Error('AWS storage bucket and table are required');
  const { s3, ddb } = createClients({ s3Client, ddbClient, region });
  const partition = `WORKSPACE#${workspaceId}`;
  const workspaceRoot = `workspaces/${workspaceId}`;

  async function getItem(key) {
    const result = await ddb.send(new GetCommand({
      TableName: tableName,
      Key: key,
      ConsistentRead: true
    }));
    return result.Item || null;
  }

  async function readObject(key) {
    try {
      const result = await s3.send(new GetObjectCommand({ Bucket: bucketName, Key: key }));
      return bodyBytes(result.Body);
    } catch (error) {
      if (error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404) return null;
      throw error;
    }
  }

  async function putObject(key, value) {
    await s3.send(new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: value,
      ContentType: 'application/json'
    }));
  }

  /**
   * Create the object only if none exists; true when this call created it.
   * S3 conditional write (If-None-Match: *): of concurrent calls for one key
   * the first to finish succeeds and the rest get 412, on every API pod.
   */
  async function putObjectIfAbsent(key, value) {
    for (let attempt = 0; ; attempt++) {
      try {
        await s3.send(new PutObjectCommand({
          Bucket: bucketName,
          Key: key,
          Body: value,
          ContentType: 'application/json',
          IfNoneMatch: '*'
        }));
        return true;
      } catch (error) {
        const status = error?.$metadata?.httpStatusCode;
        if (error?.name === 'PreconditionFailed' || status === 412) return false;
        // 409: a conflicting operation was in flight; S3 asks for a retry.
        if ((error?.name === 'ConditionalRequestConflict' || status === 409) && attempt < 2) continue;
        throw error;
      }
    }
  }

  async function getDiagram(id) {
    const item = await getItem({ PK: partition, SK: `DIAGRAM#${id}` });
    if (!item?.objectKey) return null;
    return readObject(item.objectKey);
  }

  /**
   * `known`: the metadata item the caller read in this request
   * (getDiagramState().item, or null for "there is none"), so the save does
   * not read it again. Safe even if it is stale by now: the write below is
   * conditional on its version, and a stale one is refused as a conflict.
   */
  async function putDiagram(id, value, expectedVersion, known) {
    const key = { PK: partition, SK: `DIAGRAM#${id}` };
    const existing = known !== undefined ? known : await getItem(key);
    if (existing && expectedVersion === undefined) throw preconditionError();
    if (!existing && expectedVersion !== undefined && expectedVersion !== 0) throw conflictError();
    if (existing && existing.version !== expectedVersion) throw conflictError(existing.version);
    const nextVersion = (existing?.version || 0) + 1;
    const objectKey = `${workspaceRoot}/diagrams/${id}/${nextVersion}-${crypto.randomUUID()}.json`;
    const data = decodeJson(value);
    await putObject(objectKey, value);
    const item = {
      ...key,
      workspaceId,
      objectKey,
      version: nextVersion,
      name: data?.name || data?.title || 'Untitled Diagram',
      lastModified: data?.lastModified || new Date().toISOString(),
      folderId: data?.folderId ?? null,
      deletedAt: data?.deletedAt ?? null,
      // What the next save needs, so it reads this item and not the object:
      // the server-owned fields to carry over, and the digest that tells an
      // unchanged save apart (routes.js saveDiagram).
      owned: pickServerOwned(data),
      contentHash: await contentHash(data)
    };
    try {
      await ddb.send(new PutCommand({
        TableName: tableName,
        Item: item,
        ...(existing
          ? {
              ConditionExpression: '#version = :expectedVersion',
              ExpressionAttributeNames: { '#version': 'version' },
              ExpressionAttributeValues: { ':expectedVersion': existing.version }
            }
          : { ConditionExpression: 'attribute_not_exists(PK)' })
      }));
    } catch (error) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucketName, Key: objectKey })).catch(() => {});
      if (error?.name === 'ConditionalCheckFailedException') throw conflictError();
      throw error;
    }
    // S3 versioning is enabled by infra. Older versions are retained as a
    // recovery aid and lifecycle policy can expire them independently.
    return { version: nextVersion };
  }

  async function deleteDiagram(id, expectedVersion) {
    const key = { PK: partition, SK: `DIAGRAM#${id}` };
    const existing = await getItem(key);
    if (!existing) return;
    if (expectedVersion === undefined) throw preconditionError();
    if (existing.version !== expectedVersion) throw conflictError();
    try {
      await ddb.send(new DeleteCommand({
        TableName: tableName,
        Key: key,
        ConditionExpression: '#version = :expectedVersion',
        ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: { ':expectedVersion': existing.version }
      }));
    } catch (error) {
      if (error?.name === 'ConditionalCheckFailedException') throw conflictError();
      throw error;
    }
  }

  async function getPublic(uuid) {
    const item = await getItem({ PK: `PUBLIC#${uuid}`, SK: 'SNAPSHOT' });
    if (!item?.objectKey) return null;
    return readObject(item.objectKey);
  }

  async function putPublic(uuid, value) {
    const objectKey = `${workspaceRoot}/public/${uuid}.json`;
    await putObject(objectKey, value);
    try {
      await ddb.send(new PutCommand({
        TableName: tableName,
        Item: {
          PK: `PUBLIC#${uuid}`,
          SK: 'SNAPSHOT',
          workspaceId,
          objectKey,
          createdAt: new Date().toISOString()
        },
        ConditionExpression: 'attribute_not_exists(PK) OR workspaceId = :workspaceId',
        ExpressionAttributeValues: { ':workspaceId': workspaceId }
      }));
    } catch (error) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucketName, Key: objectKey })).catch(() => {});
      if (error?.name === 'ConditionalCheckFailedException') throw conflictError();
      throw error;
    }
  }

  async function deletePublic(uuid) {
    const key = { PK: `PUBLIC#${uuid}`, SK: 'SNAPSHOT' };
    const existing = await getItem(key);
    if (!existing || existing.workspaceId !== workspaceId) return;
    await ddb.send(new DeleteCommand({
      TableName: tableName,
      Key: key,
      ConditionExpression: 'workspaceId = :workspaceId',
      ExpressionAttributeValues: { ':workspaceId': workspaceId }
    }));
    await s3.send(new DeleteObjectCommand({ Bucket: bucketName, Key: existing.objectKey }));
  }

  const adapter = {
    workspaceId,
    async get(key) {
      const diagram = DIAGRAM_KEY_RE.exec(key);
      if (diagram) return getDiagram(diagram[1]);
      const snapshot = PUBLIC_KEY_RE.exec(key);
      if (snapshot) return getPublic(snapshot[1]);
      return readObject(`${workspaceRoot}/objects/${key}.json`);
    },
    async put(key, value, options = {}) {
      const diagram = DIAGRAM_KEY_RE.exec(key);
      if (diagram) return putDiagram(diagram[1], value, options.expectedVersion, options.known);
      const snapshot = PUBLIC_KEY_RE.exec(key);
      if (snapshot) return putPublic(snapshot[1], value);
      return putObject(`${workspaceRoot}/objects/${key}.json`, value);
    },
    /** Generic objects only: create if absent; true when this call created it (atomic). */
    async putIfAbsent(key, value) {
      if (DIAGRAM_KEY_RE.test(key) || PUBLIC_KEY_RE.test(key)) {
        throw new Error('putIfAbsent is for generic objects, not diagrams or public snapshots');
      }
      return putObjectIfAbsent(`${workspaceRoot}/objects/${key}.json`, value);
    },
    async delete(key, options = {}) {
      const diagram = DIAGRAM_KEY_RE.exec(key);
      if (diagram) return deleteDiagram(diagram[1], options.expectedVersion);
      const snapshot = PUBLIC_KEY_RE.exec(key);
      if (snapshot) return deletePublic(snapshot[1]);
      await s3.send(new DeleteObjectCommand({
        Bucket: bucketName,
        Key: `${workspaceRoot}/objects/${key}.json`
      }));
      return undefined;
    },
    async list(prefix) {
      const s3Prefix = `${workspaceRoot}/objects/${prefix}`;
      const keys = [];
      let continuationToken;
      do {
        const result = await s3.send(new ListObjectsV2Command({
          Bucket: bucketName,
          Prefix: s3Prefix,
          ContinuationToken: continuationToken
        }));
        for (const object of result.Contents || []) {
          if (object.Key?.endsWith('.json')) {
            keys.push(object.Key.slice(`${workspaceRoot}/objects/`.length, -5));
          }
        }
        continuationToken = result.NextContinuationToken;
      } while (continuationToken);
      return keys;
    },
    async listDiagramMeta() {
      const items = [];
      let ExclusiveStartKey;
      do {
        const result = await ddb.send(new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
          ExpressionAttributeValues: { ':pk': partition, ':prefix': 'DIAGRAM#' },
          ExclusiveStartKey
        }));
        items.push(...(result.Items || []));
        ExclusiveStartKey = result.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      return items.map((item) => ({
        id: item.SK.slice('DIAGRAM#'.length),
        name: item.name || 'Untitled Diagram',
        lastModified: item.lastModified,
        folderId: item.folderId ?? null,
        deletedAt: item.deletedAt ?? null,
        version: item.version
      }));
    },
    async getDiagramVersion(id) {
      return (await getItem({ PK: partition, SK: `DIAGRAM#${id}` }))?.version ?? null;
    },
    /**
     * What a save needs, from the metadata item alone: its version, the
     * server-owned fields (`owned`; null for an item written before they were
     * kept there, meaning "read the object": readDocument()), and the content
     * digest. `item` goes back to put() as `known`. Null when there is no such
     * diagram.
     */
    async getDiagramState(id) {
      const item = await getItem({ PK: partition, SK: `DIAGRAM#${id}` });
      if (!item) return null;
      return {
        version: item.version,
        owned: item.owned ?? null,
        contentHash: item.contentHash ?? null,
        item,
        /** The stored document this item points at (no second item read). */
        readDocument: async () => decodeJson(item.objectKey ? await readObject(item.objectKey) : null)
      };
    },
    /** The diagram and its version from one metadata read. */
    async getDiagramWithVersion(id) {
      const item = await getItem({ PK: partition, SK: `DIAGRAM#${id}` });
      if (!item?.objectKey) return null;
      const bytes = await readObject(item.objectKey);
      return bytes ? { bytes, version: item.version } : null;
    },
    forWorkspace(nextWorkspaceId) {
      return createAwsWorkspaceAdapter({
        workspaceId: nextWorkspaceId,
        bucketName,
        tableName,
        region,
        s3Client: s3,
        ddbClient: ddb
      });
    }
  };
  return adapter;
}

export function createAwsPublicAdapter({ bucketName, tableName, region, s3Client, ddbClient }) {
  const { s3, ddb } = createClients({ s3Client, ddbClient, region });
  return {
    async get(key) {
      const snapshot = PUBLIC_KEY_RE.exec(key);
      if (!snapshot) return null;
      const result = await ddb.send(new GetCommand({
        TableName: tableName,
        Key: { PK: `PUBLIC#${snapshot[1]}`, SK: 'SNAPSHOT' },
        ConsistentRead: true
      }));
      if (!result.Item?.workspaceId) return null;
      const scoped = createAwsWorkspaceAdapter({
        workspaceId: result.Item.workspaceId,
        bucketName,
        tableName,
        region,
        s3Client,
        ddbClient
      });
      return scoped.get(key);
    },
    forWorkspace(workspaceId) {
      return createAwsWorkspaceAdapter({
        workspaceId,
        bucketName,
        tableName,
        region,
        s3Client,
        ddbClient
      });
    },
    async put() { throw new Error('Anonymous adapter is read-only'); },
    async delete() { throw new Error('Anonymous adapter is read-only'); },
    async list() { return []; },
    async listDiagramMeta() { return []; },
    async healthcheck() {
      await Promise.all([
        s3.send(new ListObjectsV2Command({ Bucket: bucketName, Prefix: 'workspaces/', MaxKeys: 1 })),
        ddb.send(new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: 'PK = :pk',
          ExpressionAttributeValues: { ':pk': 'SYSTEM#health' },
          Limit: 1
        }))
      ]);
      return true;
    }
  };
}
