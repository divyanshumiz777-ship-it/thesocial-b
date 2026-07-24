/**
 * Migration 006: Re-upload PDF attachments stored under the wrong Cloudinary
 * resource type
 *
 * Why: every attachment-upload path used `resource_type: "auto"` for
 * documents. Cloudinary's auto-detection classifies PDFs as an `image`
 * resource (it has native PDF-page-rendering support baked into its image
 * pipeline), producing a `/image/upload/.../file.pdf` delivery URL that
 * isn't a plain file passthrough — browsers opening it directly get
 * "Failed to load PDF document". The upload code now forces
 * `resource_type: "raw"` for documents (see lib/fileUpload.ts's
 * getCloudinaryResourceType), which fixes every upload from now on, but
 * PDFs sent before that fix have their broken `/image/upload/` URL
 * permanently baked into both Cloudinary and the Message documents that
 * reference it. This migration finds those, re-uploads the same bytes
 * under `resource_type: "raw"`, and repoints every Message that referenced
 * the old URL (including forwarded copies, which share the source
 * message's attachment URLs) at the new one.
 *
 * A message's own attachment list is source-of-truth; the old `image`-type
 * Cloudinary asset is left in place (not deleted) since nothing but this
 * migration's own read touches it and deleting cloud assets is not
 * something to do speculatively.
 *
 * Run once (reads MONGO_URI + CLOUDINARY_* from backend/.env):
 *   npx tsx src/models/migrations/006_fix_pdf_attachment_resource_type.ts
 * Safe to re-run: only touches attachments whose url still contains
 * /image/upload/ and whose mimeType is application/pdf; already-migrated
 * attachments no longer match and are skipped.
 */

import "dotenv/config";
import mongoose from "mongoose";
import { v2 as cloudinary } from "cloudinary";
import Message from "../Message.ts";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const IMAGE_UPLOAD_URL_RE =
  /^https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/(?:v\d+\/)?(.+)\.([a-zA-Z0-9]+)$/;

interface ParsedUrl {
  publicId: string;
  format: string;
}

function parseImageUploadUrl(url: string): ParsedUrl | null {
  const m = url.match(IMAGE_UPLOAD_URL_RE);
  if (!m) return null;
  return { publicId: m[1], format: m[2] };
}

// The broken URL was uploaded as `type: "upload"` (never "authenticated"),
// so plain delivery normally works — but some Cloudinary accounts have
// "Allow delivery of PDF and ZIP files" (Security settings) disabled,
// which blocks it regardless of resource_type. A signed URL is the
// documented bypass for that restriction, so we try plain delivery first
// and fall back to a signed URL rather than assuming which case we're in.
async function downloadPdfBytes(
  publicId: string,
  format: string,
): Promise<Buffer | null> {
  const attempts = [
    cloudinary.url(publicId, {
      resource_type: "image",
      type: "upload",
      format,
      secure: true,
    }),
    cloudinary.url(publicId, {
      resource_type: "image",
      type: "upload",
      format,
      sign_url: true,
      secure: true,
    }),
  ];

  for (const url of attempts) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const buffer = Buffer.from(await res.arrayBuffer());
      // A blocked/HTML error page would still come back 200 in some
      // Cloudinary error modes — a real PDF always starts with "%PDF-".
      if (buffer.subarray(0, 5).toString("ascii") === "%PDF-") return buffer;
    } catch {
      // try the next strategy
    }
  }
  return null;
}

async function run(): Promise<void> {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("[006] MONGO_URI is not set");
    process.exit(1);
  }
  if (
    !process.env.CLOUDINARY_CLOUD_NAME ||
    !process.env.CLOUDINARY_API_KEY ||
    !process.env.CLOUDINARY_API_SECRET
  ) {
    console.error("[006] CLOUDINARY_* env vars are not fully set");
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log("[006] Connected to MongoDB");

  const affected = await Message.find({
    attachmentsV2: {
      $elemMatch: {
        mimeType: "application/pdf",
        url: { $regex: "/image/upload/" },
      },
    },
  });
  console.log(`[006] ${affected.length} message(s) reference a broken PDF URL`);

  const migrated = new Map<string, string | null>(); // oldUrl -> newUrl (null = failed)
  let messagesUpdated = 0;
  let filesMigrated = 0;
  let filesFailed = 0;

  for (const message of affected) {
    let changed = false;

    for (const attachment of message.attachmentsV2 ?? []) {
      if (attachment.mimeType !== "application/pdf") continue;
      if (!attachment.url.includes("/image/upload/")) continue;

      if (!migrated.has(attachment.url)) {
        const parsed = parseImageUploadUrl(attachment.url);
        if (!parsed) {
          console.error(`[006] Could not parse URL, skipping: ${attachment.url}`);
          migrated.set(attachment.url, null);
        } else {
          const bytes = await downloadPdfBytes(parsed.publicId, parsed.format);
          if (!bytes) {
            console.error(
              `[006] Failed to download original PDF bytes for ${attachment.url} — ` +
                `this account may have "Allow delivery of PDF and ZIP files" disabled ` +
                `(Cloudinary Console → Settings → Security). Skipping.`,
            );
            migrated.set(attachment.url, null);
            filesFailed++;
          } else {
            const folder = parsed.publicId.split("/").slice(0, -1).join("/");
            try {
              const uploaded = await new Promise<string>((resolve, reject) => {
                const stream = cloudinary.uploader.upload_stream(
                  { folder, resource_type: "raw" },
                  (error, result) => {
                    if (error) reject(error);
                    else if (result) resolve(result.secure_url);
                    else reject(new Error("Upload returned no result"));
                  },
                );
                stream.end(bytes);
              });
              migrated.set(attachment.url, uploaded);
              filesMigrated++;
              console.log(`[006] Migrated ${attachment.url} -> ${uploaded}`);
            } catch (err) {
              console.error(`[006] Re-upload failed for ${attachment.url}:`, err);
              migrated.set(attachment.url, null);
              filesFailed++;
            }
          }
        }
      }

      const newUrl = migrated.get(attachment.url);
      if (newUrl) {
        attachment.url = newUrl;
        changed = true;
      }
    }

    if (changed) {
      message.attachments = (message.attachments ?? []).map(
        (url) => migrated.get(url) || url,
      );
      await message.save();
      messagesUpdated++;
    }
  }

  console.log(
    `[006] Done. ${filesMigrated} file(s) re-uploaded, ${filesFailed} failed, ` +
      `${messagesUpdated} message(s) updated.`,
  );

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error("[006] Migration failed:", err);
  process.exit(1);
});
