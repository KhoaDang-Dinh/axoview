/**
 * One S3 Vectors index (the public docs index Terraform creates; infra
 * modules/environment/docs_search.tf). Keys are manual chunk ids; metadata is
 * small and filterable ({ audience, hash }). Chunk text is not stored: the API
 * already ships the corpus, so a query maps keys back to the text it serves,
 * and a stale key from an older release maps to nothing.
 */
import { createAwsJsonClient } from './awsJson.js';

const NAME_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const PUT_BATCH = 500;
const DELETE_BATCH = 500;

export function createVectorIndex({ region, bucket, index, fetchImpl, credentials, call } = {}) {
  if (!NAME_RE.test(bucket || '') || !NAME_RE.test(index || '')) throw new Error('Invalid vector bucket or index name');
  const send = call || createAwsJsonClient({
    region, service: 's3vectors', hostname: `s3vectors.${region}.api.aws`, fetchImpl, credentials
  });
  const target = { vectorBucketName: bucket, indexName: index };
  const f32 = (vector) => ({ float32: vector.map(Number) });

  return {
    /** Nearest keys first: [{ key, distance, metadata }]. */
    async query(vector, { topK = 10, filter } = {}) {
      const result = await send('/QueryVectors', {
        ...target, queryVector: f32(vector), topK, returnDistance: true, returnMetadata: true,
        ...(filter ? { filter } : {})
      });
      return Array.isArray(result?.vectors) ? result.vectors : [];
    },
    /** Every key with its metadata. */
    async list() {
      const vectors = [];
      let nextToken;
      do {
        const page = await send('/ListVectors', {
          ...target, maxResults: 1000, returnMetadata: true, ...(nextToken ? { nextToken } : {})
        });
        vectors.push(...(page?.vectors || []));
        nextToken = page?.nextToken;
      } while (nextToken);
      return vectors;
    },
    async put(vectors) {
      for (let start = 0; start < vectors.length; start += PUT_BATCH) {
        await send('/PutVectors', {
          ...target,
          vectors: vectors.slice(start, start + PUT_BATCH)
            .map(({ key, data, metadata }) => ({ key, data: f32(data), metadata }))
        });
      }
    },
    async delete(keys) {
      for (let start = 0; start < keys.length; start += DELETE_BATCH) {
        await send('/DeleteVectors', { ...target, keys: keys.slice(start, start + DELETE_BATCH) });
      }
    }
  };
}
