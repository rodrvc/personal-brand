import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";

import {
  ObjectNotFoundError,
  PreconditionFailedError,
  type GetResult,
  type HeadResult,
  type ListedObject,
  type ObjectStore,
  type PutOptions,
  type PutResult,
} from "./object-store.js";

export interface S3ObjectStoreOptions {
  bucket: string;
  endpoint?: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

async function bodyToBuffer(body: unknown): Promise<Buffer> {
  // The SDK's GetObjectCommand body is a Node.js Readable in this runtime.
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

interface AwsErrorShape {
  name?: string;
  Code?: string;
  $metadata?: { httpStatusCode?: number };
}

function isNotFound(error: unknown): boolean {
  const shaped = error as AwsErrorShape;
  const name = shaped?.Code ?? shaped?.name;
  return name === "NoSuchKey" || name === "NotFound" || shaped?.$metadata?.httpStatusCode === 404;
}

function isPreconditionFailed(error: unknown): boolean {
  const shaped = error as AwsErrorShape;
  const name = shaped?.Code ?? shaped?.name;
  const status = shaped?.$metadata?.httpStatusCode;
  return name === "PreconditionFailed" || status === 412 || status === 409;
}

function normalizeEtag(etag: string | undefined): string {
  return (etag ?? "").replace(/^"|"$/g, "");
}

/** `ObjectStore` backed by an S3-compatible bucket (AWS S3, MinIO, Cloudflare R2, Railway buckets). */
export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(options: S3ObjectStoreOptions) {
    this.bucket = options.bucket;
    const config: S3ClientConfig = {
      region: options.region,
      forcePathStyle: options.forcePathStyle,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    };
    if (options.endpoint) config.endpoint = options.endpoint;
    this.client = new S3Client(config);
  }

  async get(key: string): Promise<GetResult> {
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const body = await bodyToBuffer(result.Body);
      return { body, etag: normalizeEtag(result.ETag) };
    } catch (error) {
      if (isNotFound(error)) throw new ObjectNotFoundError(key);
      throw error;
    }
  }

  async head(key: string): Promise<HeadResult> {
    try {
      const result = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { etag: normalizeEtag(result.ETag), size: result.ContentLength ?? 0, metadata: result.Metadata ?? {} };
    } catch (error) {
      if (isNotFound(error)) throw new ObjectNotFoundError(key);
      throw error;
    }
  }

  async put(key: string, body: Buffer, options?: PutOptions): Promise<PutResult> {
    try {
      const result = await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: options?.contentType,
          IfMatch: options?.ifMatch,
          IfNoneMatch: options?.ifNoneMatch,
          Metadata: options?.metadata,
        }),
      );
      return { etag: normalizeEtag(result.ETag) };
    } catch (error) {
      if (isPreconditionFailed(error)) throw new PreconditionFailedError(key);
      throw error;
    }
  }

  async list(prefix: string): Promise<ListedObject[]> {
    const results: ListedObject[] = [];
    let continuationToken: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const item of page.Contents ?? []) {
        if (!item.Key) continue;
        results.push({ key: item.Key, etag: normalizeEtag(item.ETag), size: item.Size ?? 0 });
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
    return results;
  }
}
