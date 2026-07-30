import { describe, it, expect } from "vitest";
import { deriveVideoThumbnailUrl } from "../src/lib/cloudinary.ts";

describe("deriveVideoThumbnailUrl", () => {
  it("inserts so_0 right after /upload/, before the version segment, and swaps the extension to .jpg", () => {
    const videoUrl =
      "https://res.cloudinary.com/dt15dfgkw/video/upload/v1784958307/discord_clone/videos/xyz123.mp4";
    expect(deriveVideoThumbnailUrl(videoUrl)).toBe(
      "https://res.cloudinary.com/dt15dfgkw/video/upload/so_0/v1784958307/discord_clone/videos/xyz123.jpg",
    );
  });

  it("handles a video URL with no version segment", () => {
    const videoUrl = "https://res.cloudinary.com/dt15dfgkw/video/upload/discord_clone/videos/xyz123.webm";
    expect(deriveVideoThumbnailUrl(videoUrl)).toBe(
      "https://res.cloudinary.com/dt15dfgkw/video/upload/so_0/discord_clone/videos/xyz123.jpg",
    );
  });

  it("returns undefined for a non-Cloudinary URL", () => {
    expect(deriveVideoThumbnailUrl("https://example.com/video.mp4")).toBeUndefined();
  });

  it("returns undefined for a Cloudinary image (not video) delivery URL", () => {
    const imageUrl = "https://res.cloudinary.com/dt15dfgkw/image/upload/v123/discord_clone/images/pic.png";
    expect(deriveVideoThumbnailUrl(imageUrl)).toBeUndefined();
  });

  it("returns undefined for a malformed/extension-less URL", () => {
    expect(
      deriveVideoThumbnailUrl("https://res.cloudinary.com/dt15dfgkw/video/upload/v123/discord_clone/videos/xyz"),
    ).toBeUndefined();
  });
});
