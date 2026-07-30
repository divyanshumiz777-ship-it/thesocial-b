import {
  v2 as cloudinary,
  UploadApiResponse,
  UploadApiErrorResponse,
  UploadApiOptions,
} from "cloudinary";
import { Readable } from "stream";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

type CloudinaryUploadOptions = Pick<
  UploadApiOptions,
  "resource_type" | "folder" | "public_id"
>;

const uploadOnCloudinary = (
  buffer: Buffer,
  options: CloudinaryUploadOptions
): Promise<UploadApiResponse> => {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      options,
      (
        error: UploadApiErrorResponse | undefined,
        result: UploadApiResponse | undefined
      ) => {
        if (error) reject(error);
        if (result) resolve(result);
        else
          reject(
            new Error("Cloudinary upload failed without an error or result.")
          );
      }
    );
    Readable.from(buffer).pipe(uploadStream);
  });
};

// Matches a Cloudinary video delivery URL and captures the pieces needed to
// insert a transformation: everything through "/upload/", an optional
// "v<version>/" segment, the public id path, and the original extension.
const CLOUDINARY_VIDEO_URL_PATTERN =
  /^(https?:\/\/res\.cloudinary\.com\/[^/]+\/video\/upload\/)(v\d+\/)?(.+)\.[a-z0-9]+$/i;

// Derives a first-frame thumbnail URL from an already-uploaded Cloudinary
// video URL — no re-upload, no ffmpeg, no eager transform configured at
// upload time. Cloudinary generates (and caches) the frame image lazily the
// first time this derived URL is actually requested. `so_0` = start-offset
// 0 seconds, i.e. the first frame.
//
// Returns undefined (rather than throwing) for any URL that doesn't match
// the expected Cloudinary video shape — callers should treat that as "no
// thumbnail available" and fall back to their existing no-thumbnail UI,
// not fail the whole operation over a thumbnail.
export function deriveVideoThumbnailUrl(videoUrl: string): string | undefined {
  const match = videoUrl.match(CLOUDINARY_VIDEO_URL_PATTERN);
  if (!match) return undefined;
  const [, base, versionSegment = "", publicIdPath] = match;
  return `${base}so_0/${versionSegment}${publicIdPath}.jpg`;
}

export { uploadOnCloudinary };
