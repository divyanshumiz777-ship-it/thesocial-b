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

export { uploadOnCloudinary };
