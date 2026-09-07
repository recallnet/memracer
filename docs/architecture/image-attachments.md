# Task image attachments

Private task screenshots use metadata-only evidence rows for authority and object-store blobs for opaque bytes.

# Authority and storage

The database decides whether an attachment exists, which task and Project own
it, and who may read it. An `evidence` row with `kind = 'image'` stores only
`blob_ref`, validated `mime_type`, and optional `caption`; the existing text
evidence fields are null. Image bytes never enter SQLite, Postgres, task bodies,
or stored JSON.

An S3-compatible object store (R2 in the hosted deployment) holds opaque
objects under a server-generated `images/<project>/<task>/<uuid>` key. The key is not an authorization
capability and is never returned to a caller. A blob without a matching image
evidence row is unreachable through memracer. A row whose blob is missing
remains the authoritative attachment record but cannot yield image bytes.

This is a narrow exception to "the DB is the only source of truth": the DB
remains the only authority for application state and metadata, while the
object store is the external byte store. See [architecture](architecture.md).

# Write path

`human_attach_image` is the only upload surface. Project humans and admins may
attach one image to an existing task in their token-scoped Project. The call
accepts canonical base64 for PNG, JPEG, GIF, or WebP, rejects SVG and other
media, and caps decoded bytes at 10 MiB. Base64 exists only in this single MCP
request; the success response contains metadata only, without the payload or object key.

The service writes the object before inserting the evidence row. A failed
upload creates no row. A failed DB insert triggers a best-effort object delete;
if that delete also fails, the result is an unreachable orphan object with no
visible attachment. The object store and SQL cannot share a transaction, so this
compensation is the consistency boundary.

Missing object-store configuration does not prevent server boot. It makes attachment
writes fail with an actionable configuration error. Ordinary task and text
evidence operations continue.

# Read and delivery paths

Ordinary `/queue`, `/tasks/:id`, `human_status`, and task-brief JSON stay
byte-stable after an image is attached. They continue to project text evidence
only. Two separate reads expose images:

- `GET /api/p/:project/tasks/:task/images` returns gallery metadata only and
  attachment ids after browser-session membership checks.
- `GET /p/:project/images/:id` accepts the normal authenticated browser session
  or Project-scoped bearer key, resolves the evidence row through its task and
  Project, then returns the exact stored bytes with the stored media type,
  `X-Content-Type-Options: nosniff`, and private no-store caching. Unknown,
  cross-Project, missing, and unreadable objects are concealed as not found.

`coder_claim_task` completes its atomic claim before reading blobs. Its first
content block remains the existing compact JSON brief. It appends MCP
`ImageContent` blocks up to a 10 MiB aggregate decoded budget. Attachments over
that budget, and attachments whose blob read fails, appear in a concise
fallback block as authenticated binary-route URLs. A blob-store failure never
undoes or fails a successful claim. The coder's existing bearer credential is
still required to fetch a fallback URL.

# Dashboard

Task detail fetches the dedicated image metadata route independently from the
ordinary task query. The gallery lazy-loads authenticated binary routes,
contains raster dimensions without horizontal overflow, and uses the caption
as alt text when present. Loading, unavailable-image, and empty states stay
inside the gallery. The dashboard remains read-only; it has no upload or
presigned-write path. See [dashboard](dashboard.md).

# Operations and recovery

The server reads the object-store coordinates from `LITESTREAM_S3_BUCKET`,
`LITESTREAM_S3_ENDPOINT`, `LITESTREAM_ACCESS_KEY_ID`, and
`LITESTREAM_SECRET_ACCESS_KEY`. The principal needs GetObject, PutObject, and
DeleteObject for the `images/` prefix. ListBucket is not part of the request
path. Without those variables the server boots and ordinary task work
continues, but attachment writes fail with a configuration error.

A database backup covers only SQLite or Postgres metadata. Object retention and
versioning are a separate recovery leg. A database restore can recover
attachment associations only when the corresponding objects still exist;
without those objects, metadata survives and byte reads return not found.
Objects newer than the restored DB become unreachable orphans. There is no
public attachment-delete operation or automated orphan sweep. Project deletion,
grooming refusal that removes a task, and failed compensation can therefore
leave unreachable objects until an operator applies an `images/` prefix
retention or reconciliation policy.

# Related

- [MCP protocol](mcp-protocol.md)
- [Task lifecycle](task-lifecycle.md)
