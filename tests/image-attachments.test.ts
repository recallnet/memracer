import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import {
  createImageBlobStoreFromEnv,
  ImageAttachmentService,
  ImageAttachmentValidationError,
  type ImageBlobStore,
  type ImageMimeType,
  MAX_IMAGE_BYTES,
  R2ImageBlobStore,
} from "../src/image-attachments.js";

class MemoryBlobStore implements ImageBlobStore {
  readonly objects = new Map<string, { bytes: Uint8Array; mimeType: ImageMimeType }>();
  readonly deleted: string[] = [];

  async put(key: string, bytes: Uint8Array, mimeType: ImageMimeType): Promise<void> {
    this.objects.set(key, { bytes: bytes.slice(), mimeType });
  }

  async get(key: string): Promise<Uint8Array> {
    const object = this.objects.get(key);
    if (!object) throw new Error("missing blob");
    return object.bytes.slice();
  }

  async delete(key: string): Promise<void> {
    this.deleted.push(key);
    this.objects.delete(key);
  }
}

async function fixture() {
  const db = openDb(":memory:");
  await db.prepare("INSERT INTO projects (id, name) VALUES ('p', 'Project'), ('other', 'Other')").run();
  const task = await db.prepare(
    `INSERT INTO tasks (project_id, title, body, submitted_by, created_at, updated_at)
     VALUES ('p', 'Task', 'body', 'ada', 1, 1) RETURNING id`,
  ).get<{ id: number }>();
  const blobs = new MemoryBlobStore();
  return { db, taskId: task!.id, blobs, service: new ImageAttachmentService(db, blobs) };
}

describe("ImageAttachmentService", () => {
  it("persists metadata only, keeps the object key private, and scopes reads to the project", async () => {
    const { db, taskId, blobs, service } = await fixture();
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);

    const attached = await service.attach({
      projectId: "p",
      taskId,
      bytes,
      mimeType: "image/png",
      caption: "Queue is stuck",
    });

    expect(attached).toEqual({
      id: expect.any(Number),
      taskId,
      mimeType: "image/png",
      caption: "Queue is stuck",
    });
    expect(attached).not.toHaveProperty("blob_ref");
    const row = await db.prepare("SELECT * FROM evidence WHERE id = ?").get<Record<string, unknown>>(attached.id);
    expect(row).toMatchObject({
      task_id: taskId,
      kind: "image",
      path: null,
      lines: null,
      snippet: null,
      note: null,
      mime_type: "image/png",
      caption: "Queue is stuck",
    });
    expect(blobs.objects.size).toBe(1);
    const [key] = blobs.objects.keys();
    expect(row!.blob_ref).toBe(key);
    expect(key).toMatch(new RegExp(`^images/p/${taskId}/`));

    expect(await service.list("p", taskId)).toEqual([attached]);
    expect(await service.find("p", attached.id)).toEqual(attached);
    expect(await service.read("p", attached.id)).toEqual({ attachment: attached, bytes });
    expect(await service.find("other", attached.id)).toBeUndefined();
    expect(await service.read("other", attached.id)).toBeUndefined();
    await db.close();
  });

  it("accepts the exact 10 MiB boundary and rejects empty, oversized, and unsupported images before upload", async () => {
    const { db, taskId, blobs, service } = await fixture();
    await expect(service.attach({
      projectId: "p",
      taskId,
      bytes: new Uint8Array(MAX_IMAGE_BYTES),
      mimeType: "image/webp",
    })).resolves.toMatchObject({ mimeType: "image/webp" });
    expect(blobs.objects.size).toBe(1);

    await expect(service.attach({
      projectId: "p",
      taskId,
      bytes: new Uint8Array(),
      mimeType: "image/png",
    })).rejects.toBeInstanceOf(ImageAttachmentValidationError);
    await expect(service.attach({
      projectId: "p",
      taskId,
      bytes: new Uint8Array(MAX_IMAGE_BYTES + 1),
      mimeType: "image/jpeg",
    })).rejects.toThrow(/exceeds/);
    await expect(service.attach({
      projectId: "p",
      taskId,
      bytes: Uint8Array.of(1),
      mimeType: "image/svg+xml" as ImageMimeType,
    })).rejects.toThrow(/Unsupported/);
    expect(blobs.objects.size).toBe(1);
    await db.close();
  });

  it("does not upload for a task outside the project", async () => {
    const { db, taskId, blobs, service } = await fixture();
    await expect(service.attach({
      projectId: "other",
      taskId,
      bytes: Uint8Array.of(1),
      mimeType: "image/gif",
    })).rejects.toThrow(/Task not found/);
    expect(blobs.objects.size).toBe(0);
    await db.close();
  });

  it("deletes the uploaded object when evidence insertion fails", async () => {
    const { db, taskId, blobs, service } = await fixture();
    await db.exec(`
      CREATE TRIGGER fail_image_insert BEFORE INSERT ON evidence
      WHEN NEW.kind = 'image'
      BEGIN SELECT RAISE(ABORT, 'metadata write failed'); END;
    `);

    await expect(service.attach({
      projectId: "p",
      taskId,
      bytes: Uint8Array.of(1, 2, 3),
      mimeType: "image/jpeg",
    })).rejects.toThrow(/metadata write failed/);
    expect(blobs.deleted).toHaveLength(1);
    expect(blobs.objects.size).toBe(0);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM evidence").get()).toEqual({ n: 0 });
    await db.close();
  });

  it("preserves the metadata error even when compensating delete also fails", async () => {
    const { db, taskId, blobs } = await fixture();
    await db.exec(`
      CREATE TRIGGER fail_image_insert BEFORE INSERT ON evidence
      WHEN NEW.kind = 'image'
      BEGIN SELECT RAISE(ABORT, 'metadata write failed'); END;
    `);
    blobs.delete = async () => { throw new Error("delete failed"); };
    const service = new ImageAttachmentService(db, blobs);

    await expect(service.attach({
      projectId: "p",
      taskId,
      bytes: Uint8Array.of(1),
      mimeType: "image/png",
    })).rejects.toThrow(/metadata write failed/);
    await db.close();
  });
});

describe("image blob configuration", () => {
  it("fails closed with an actionable error when R2 configuration is incomplete", async () => {
    const store = createImageBlobStoreFromEnv({});
    await expect(store.put("key", Uint8Array.of(1), "image/png")).rejects.toThrow(
      /LITESTREAM_S3_BUCKET.*LITESTREAM_S3_ENDPOINT.*LITESTREAM_ACCESS_KEY_ID.*LITESTREAM_SECRET_ACCESS_KEY/,
    );
  });

  it("creates the R2 adapter only when all existing Litestream coordinates are present", () => {
    expect(createImageBlobStoreFromEnv({
      LITESTREAM_S3_BUCKET: "bucket",
      LITESTREAM_S3_ENDPOINT: "https://account.r2.cloudflarestorage.com",
      LITESTREAM_ACCESS_KEY_ID: "access",
      LITESTREAM_SECRET_ACCESS_KEY: "secret",
    })).toBeInstanceOf(R2ImageBlobStore);
  });
});
