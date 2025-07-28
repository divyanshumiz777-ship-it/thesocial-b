import { Context } from "hono";
import User from "../models/User.ts";
import { sign } from "hono/jwt";
import argon2 from "argon2";
import { uploadOnCloudinary } from "../lib/cloudinary.ts";
import { Buffer } from "node:buffer";

export const registerUser = async (c: Context) => {
  const formData = await c.req.formData();

  const email = formData.get("email") as string;
  const password = formData.get("password") as string;
  const name = formData.get("name") as string;
  const profilePicFile = formData.get("profilePic") as File | null;

  if (!email || !password || !name) {
    return c.json({ error: "Name, email, and password are required" }, 400);
  }
  if (!process.env.JWT_SECRET) {
    console.error("JWT_SECRET missing");
    return c.json({ error: "Server misconfigured" }, 500);
  }

  const existingUser = await User.findOne({ email });
  if (existingUser) {
    return c.json({ error: "User already exists" }, 409);
  }

  const hashedPassword = await argon2.hash(password);

  const newUser = new User({
    name,
    email,
    password: hashedPassword,
  });

  if (profilePicFile && profilePicFile.size > 0) {
    try {
      const arrayBuffer = await profilePicFile.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      const cloudinaryResponse = await uploadOnCloudinary(buffer, {
        folder: "profile_pics",
        resource_type: "image",
      });

      if (cloudinaryResponse) {
        newUser.profilePic = cloudinaryResponse.secure_url;
      }
    } catch (error) {
      console.error("Error uploading profile picture to Cloudinary:", error);
      return c.json({ error: "Failed to upload profile picture" }, 500);
    }
  }
  await newUser.save();

  return c.json({ message: "User registered successfully", newUser }, 201);
};

export const googleSignIn = async (
  c: Context<{ Bindings: { JWT_SECRET: string } }>
) => {
  const body = await c.req.json();
  const { name, email, profilePic } = body;
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    console.error("JWT_SECRET missing");
    return c.json({ error: "Server misconfigured" }, 500);
  }
  try {
    let user = await User.findOne({ email }).exec();

    if (!user) {
      user = new User({
        name,
        email,
        profilePic,
        provider: "google",
      });
      await user.save();
    }
    const payload = {
      userId: user._id,
      provider: user.provider,
      exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7,
    };
    const token = await sign(payload, jwtSecret);
    return c.json({ message: "Google sign-in successful", token, payload });
  } catch (error) {
    console.error("Google sign-in error:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const loginUser = async (c: Context) => {
  const { email, password } = await c.req.json();

  if (!email || !password) {
    return c.json({ error: "Email and Password required" }, 400);
  }

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    console.error("JWT_SECRET missing");
    return c.json({ error: "Server misconfigured" }, 500);
  }

  try {
    const existingUser = await User.findOne({ email })
      .select("+password")
      .exec();

    if (!existingUser) {
      return c.json({ error: "No user with the provided email exists" }, 409);
    }
    if (existingUser.provider !== "local") {
      return c.json(
        {
          error: `This account was registered via ${existingUser.provider}. Please login using ${existingUser.provider}`,
        },
        403
      );
    }

    if (!existingUser.password) {
      return c.json(
        {
          error: `Please login using ${existingUser.provider}`,
        },
        403
      );
    }
    const isPasswordCorrect = await argon2.verify(
      existingUser.password,
      password
    );

    if (!isPasswordCorrect) {
      return c.json({ error: "Incorrect Password" }, 401);
    }

    const payload = {
      userId: existingUser._id,
      provider: existingUser.provider,
      exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7,
    };

    const token = await sign(payload, jwtSecret);

    return c.json({ message: "Login successful", token, payload });
  } catch (error) {
    console.error("Login error:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};
