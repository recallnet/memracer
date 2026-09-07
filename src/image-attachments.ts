import { randomUUID } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { Db } from "./db.js";

export const IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;
export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number];

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export interface ImageBlobStore {
  put(key: string, bytes: Uint8Array, mimeType: ImageMimeType): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
}

export interface R2ImageBlobStoreOptions {
  bucket: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** S3-compatible R2 adapter. Keys are created by ImageAttachmentService. */
export class R2ImageBlobStore implements ImageBlobStore {
  private readonly client: S3Client;

  constructor(
    private readonly options: R2ImageBlobStoreOptions,
    client?: S3Client,
  ) {
    this.client = client ?? new S3Client({
      region: "auto",
      endpoint: options.endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    });
  }

  async put(key: string, bytes: Uint8Array, mimeType: ImageMimeType): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.options.bucket,
      Key: key,
      Body: bytes,
      ContentType: mimeType,
    }));
  }

  async get(key: string): Promise<Uint8Array> {
    const result = await this.client.send(new GetObjectCommand({
      Bucket: this.options.bucket,
      Key: key,
    }));
    if (!result.Body) throw new Error("Image object returned an empty response body");
    return result.Body.transformToByteArray();
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({
      Bucket: this.options.bucket,
      Key: key,
    }));
  }
}

export class ImageBlobStoreUnavailableError extends Error {
  constructor() {
    super(
      "Image attachments are unavailable: configure LITESTREAM_S3_BUCKET, " +
      "LITESTREAM_S3_ENDPOINT, LITESTREAM_ACCESS_KEY_ID, and " +
      "LITESTREAM_SECRET_ACCESS_KEY",
    );
    this.name = "ImageBlobStoreUnavailableError";
  }
}

/** Keeps the server healthy without ever falling back to SQL or local disk. */
export class UnavailableImageBlobStore implements ImageBlobStore {
  private fail(): never {
    throw new ImageBlobStoreUnavailableError();
  }

  async put(): Promise<void> { this.fail(); }
  async get(): Promise<Uint8Array> { return this.fail(); }
  async delete(): Promise<void> { this.fail(); }
}

export function createImageBlobStoreFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ImageBlobStore {
  const bucket = env.LITESTREAM_S3_BUCKET;
  const endpoint = env.LITESTREAM_S3_ENDPOINT;
  const accessKeyId = env.LITESTREAM_ACCESS_KEY_ID;
  const secretAccessKey = env.LITESTREAM_SECRET_ACCESS_KEY;
  if (!bucket || !endpoint || !accessKeyId || !secretAccessKey) {
    return new UnavailableImageBlobStore();
  }
  return new R2ImageBlobStore({ bucket, endpoint, accessKeyId, secretAccessKey });
}

export interface ImageAttachment {
  id: number;
  taskId: number;
  mimeType: ImageMimeType;
  caption: string | null;
}

export interface AttachImageInput {
  projectId: string;
  taskId: number;
  bytes: Uint8Array;
  mimeType: ImageMimeType;
  caption?: string | null;
}

export interface ImageAttachmentRead {
  attachment: ImageAttachment;
  bytes: Uint8Array;
}

interface ImageAttachmentRow {
  id: number;
  task_id: number;
  blob_ref: string;
  mime_type: string;
  caption: string | null;
}

export class ImageAttachmentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageAttachmentValidationError";
  }
}

function toAttachment(row: ImageAttachmentRow): ImageAttachment {
  return {
    id: row.id,
    taskId: row.task_id,
    mimeType: row.mime_type as ImageMimeType,
    caption: row.caption,
  };
}

/** Metadata authority plus compensating blob lifecycle for task images. */
export class ImageAttachmentService {
  constructor(
    private readonly db: Db,
    private readonly blobs: ImageBlobStore,
  ) {}

  async attach(input: AttachImageInput): Promise<ImageAttachment> {
    if (!IMAGE_MIME_TYPES.includes(input.mimeType)) {
      throw new ImageAttachmentValidationError(`Unsupported image MIME type: ${input.mimeType}`);
    }
    if (input.bytes.byteLength === 0) {
      throw new ImageAttachmentValidationError("Image must not be empty");
    }
    if (input.bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new ImageAttachmentValidationError(`Image exceeds the ${MAX_IMAGE_BYTES}-byte limit`);
    }

    const task = await this.db
      .prepare("SELECT id FROM tasks WHERE id = ? AND project_id = ?")
      .get<{ id: number }>(input.taskId, input.projectId);
    if (!task) throw new ImageAttachmentValidationError("Task not found in project");

    const key = `images/${encodeURIComponent(input.projectId)}/${input.taskId}/${randomUUID()}`;
    await this.blobs.put(key, input.bytes, input.mimeType);
    try {
      const inserted = await this.db.prepare(
        `INSERT INTO evidence (task_id, kind, blob_ref, mime_type, caption)
         VALUES (?, 'image', ?, ?, ?) RETURNING id`,
      ).get<{ id: number }>(
        input.taskId,
        key,
        input.mimeType,
        input.caption ?? null,
      );
      if (!inserted) throw new Error("Image evidence insert returned no id");
      return {
        id: inserted.id,
        taskId: input.taskId,
        mimeType: input.mimeType,
        caption: input.caption ?? null,
      };
    } catch (error) {
      // R2 and SQL cannot share a transaction. Preserve the insertion error;
      // deletion is best effort and is safe to retry operationally.
      await this.blobs.delete(key).catch(() => undefined);
      throw error;
    }
  }

  async list(projectId: string, taskId: number): Promise<ImageAttachment[]> {
    const rows = await this.db.prepare(
      `SELECT e.id, e.task_id, e.blob_ref, e.mime_type, e.caption
         FROM evidence e JOIN tasks t ON t.id = e.task_id
        WHERE t.project_id = ? AND t.id = ? AND e.kind = 'image'
        ORDER BY e.id`,
    ).all<ImageAttachmentRow>(projectId, taskId);
    return rows.map(toAttachment);
  }

  async find(projectId: string, attachmentId: number): Promise<ImageAttachment | undefined> {
    const row = await this.findRow(projectId, attachmentId);
    return row ? toAttachment(row) : undefined;
  }

  async read(projectId: string, attachmentId: number): Promise<ImageAttachmentRead | undefined> {
    const row = await this.findRow(projectId, attachmentId);
    if (!row) return undefined;
    return { attachment: toAttachment(row), bytes: await this.blobs.get(row.blob_ref) };
  }

  private findRow(projectId: string, attachmentId: number): Promise<ImageAttachmentRow | undefined> {
    return this.db.prepare(
      `SELECT e.id, e.task_id, e.blob_ref, e.mime_type, e.caption
         FROM evidence e JOIN tasks t ON t.id = e.task_id
        WHERE t.project_id = ? AND e.id = ? AND e.kind = 'image'`,
    ).get<ImageAttachmentRow>(projectId, attachmentId);
  }
}
