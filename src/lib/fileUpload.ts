/* eslint-disable unicorn/prefer-string-replace-all */
type FileType = "image" | "video" | "document" | "audio";

export const FILE_LIMITS = {
  image: 10 * 1024 * 1024,
  video: 100 * 1024 * 1024,
  audio: 25 * 1024 * 1024,
  document: 25 * 1024 * 1024,
};

export const ALLOWED_MIME_TYPES = {
  image: [
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "image/svg+xml",
  ],
  video: ["video/mp4", "video/webm", "video/quicktime"],
  audio: ["audio/mpeg", "audio/wav", "audio/ogg", "audio/mp4"],
  document: [
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "text/plain",
  ],
};

export function getFileType(
  mimeType: string
): "image" | "video" | "document" | "audio" | "unknown" {
  if (ALLOWED_MIME_TYPES.image.includes(mimeType)) return "image";
  if (ALLOWED_MIME_TYPES.video.includes(mimeType)) return "video";
  if (ALLOWED_MIME_TYPES.audio.includes(mimeType)) return "audio";
  if (ALLOWED_MIME_TYPES.document.includes(mimeType)) return "document";
  return "unknown";
}

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
}

export function getFileSizeInMB(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 100) / 100;
}

export function validateFileSize(
  file: File | { size: number },
  fileType: string
): { valid: boolean; error?: string } {
  const limit = FILE_LIMITS[fileType as keyof typeof FILE_LIMITS];

  if (!limit) {
    return { valid: false, error: "Unknown file type" };
  }

  if (file.size > limit) {
    return {
      valid: false,
      error: `File too large. Max size for ${fileType} is ${formatFileSize(
        limit
      )}`,
    };
  }

  return { valid: true };
}

export function validateMimeType(mimeType: string): {
  valid: boolean;
  type?: FileType;
  error?: string;
} {
  const fileType = getFileType(mimeType);

  if (fileType === "unknown") {
    return {
      valid: false,
      error: "File type not supported",
    };
  }

  return {
    valid: true,
    type: fileType,
  };
}

export function validateFile(file: File): {
  valid: boolean;
  type?: FileType;
  error?: string;
} {
  const mimeValidation = validateMimeType(file.type);
  if (!mimeValidation.valid) {
    return mimeValidation;
  }

  const fileType = mimeValidation.type!;

  const sizeValidation = validateFileSize(file, fileType);
  if (!sizeValidation.valid) {
    return sizeValidation;
  }

  return { valid: true, type: fileType };
}

export function sanitizeFilename(filename: string): string {
  const baseName = filename.split(/[/\\]/).pop() || "file";

  return baseName.replace(/[^a-zA-Z0-9._-]/g, "_");
}

// Cloudinary's `resource_type: "auto"` detects PDFs/docs as `image` (it
// treats PDF pages as renderable images), returning a `/image/upload/...pdf`
// delivery URL. That URL 404s/fails to parse for callers expecting an actual
// binary document fetch (e.g. a browser's PDF viewer), because Cloudinary's
// image pipeline — not a plain file passthrough — is now serving it. Videos
// and audio need the dedicated `video` resource type; everything else
// (actual images, gifs, stickers) is safe to store as `image`.
export function getCloudinaryResourceType(
  fileType: string
): "image" | "video" | "raw" {
  if (fileType === "video" || fileType === "audio") return "video";
  if (fileType === "document") return "raw";
  return "image";
}

export function getCloudinaryFolder(fileType: string): string {
  switch (fileType) {
    case "image":
      return "discord_clone/images";
    case "video":
      return "discord_clone/videos";
    case "audio":
      return "discord_clone/audio";
    case "document":
      return "discord_clone/documents";
    default:
      return "discord_clone/files";
  }
}

export function generateUploadId(): string {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

export function getFileExtension(filename: string): string {
  const lastDotIndex = filename.lastIndexOf(".");
  return lastDotIndex > 0
    ? filename.substring(lastDotIndex + 1).toLowerCase()
    : "";
}

export function isImage(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

export function isVideo(mimeType: string): boolean {
  return mimeType.startsWith("video/");
}

export function isAudio(mimeType: string): boolean {
  return mimeType.startsWith("audio/");
}
