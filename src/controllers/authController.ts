import { Context } from "hono";
import User from "../models/User.ts";
import argon2 from "argon2";
import { Buffer } from "node:buffer";
import { uploadOnCloudinary } from "../lib/cloudinary.ts";
import { verifyTotpCode, verifyAndConsumeBackupCode } from "../lib/twoFactor.ts";
import {
  RegisterSchema,
  LoginSchema,
  ProviderLoginSchema,
  LinkProviderSchema,
} from "../lib/validators.ts";

export const registerUser = async (
  c: Context<
    any,
    any,
    { in: { form: RegisterSchema }; out: { form: RegisterSchema } }
  >,
) => {
  const body = c.req.valid("form");

  try {
    const existingUser = await User.findOne({ email: body.email });
    if (existingUser) {
      return c.json({ message: "User with this email already exists" }, 409);
    }

    const hashedPassword = await argon2.hash(body.password);

    const newUser = new User({
      name: body.name,
      email: body.email,
      password: hashedPassword,
      provider: "credentials",
    });

    const profilePicFile = body.profilePic;
    if (profilePicFile && profilePicFile.size > 0) {
      const arrayBuffer = await profilePicFile.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const cloudinaryResponse = await uploadOnCloudinary(buffer, {
        folder: "profile_pics",
      });
      if (cloudinaryResponse) {
        newUser.profilePic = cloudinaryResponse.secure_url;
      }
    }

    await newUser.save();
    return c.json({ user: newUser.toObject() }, 201);
  } catch (error) {
    console.error("Registration Error:", error);
    return c.json(
      { message: "Internal server error during registration" },
      500,
    );
  }
};

export const providerLogin = async (
  c: Context<
    any,
    any,
    { in: { json: ProviderLoginSchema }; out: { json: ProviderLoginSchema } }
  >,
) => {
  try {
    const body = c.req.valid("json");

    const existingUser = await User.findOne({ email: body.email });

    if (existingUser) {
      if (
        existingUser.provider === body.provider &&
        existingUser.providerAccountId === body.providerAccountId
      ) {
        return c.json({ user: existingUser.toObject() }, 200);
      } else if (existingUser.provider === "credentials") {
        return c.json(
          {
            message:
              "This email is already registered with a password. Please sign in to link your account.",
            code: "ACCOUNT_EXISTS_WITH_PASSWORD",
          },
          409,
        );
      } else {
        return c.json(
          {
            message: `You have already signed up with ${existingUser.provider}.`,
          },
          409,
        );
      }
    } else {
      const newUser = new User({
        name: body.name,
        email: body.email,
        profilePic: body.profilePic,
        provider: body.provider,
        providerAccountId: body.providerAccountId,
        emailVerified: true,
      });
      await newUser.save();
      return c.json({ user: newUser.toObject() }, 201);
    }
  } catch (error) {
    console.error("Provider Login Error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("Error details:", message);
    return c.json(
      { message: `Internal server error during provider login: ${message}` },
      500,
    );
  }
};

export const linkProvider = async (
  c: Context<
    any,
    any,
    { in: { json: LinkProviderSchema }; out: { json: LinkProviderSchema } }
  >,
) => {
  const loggedInUser = c.get("user");
  if (!loggedInUser) {
    return c.json({ message: "Unauthorized" }, 401);
  }

  const body = c.req.valid("json");

  if (loggedInUser.id !== body.userId) {
    return c.json({ message: "Forbidden" }, 403);
  }

  try {
    const userToUpdate = await User.findById(body.userId);
    if (!userToUpdate) {
      return c.json({ message: "User not found" }, 404);
    }

    userToUpdate.provider = body.provider;
    userToUpdate.providerAccountId = body.providerAccountId;
    await userToUpdate.save();

    return c.json({ user: userToUpdate.toObject() }, 200);
  } catch (error) {
    console.error("Link Provider Error:", error);
    return c.json(
      { message: "Internal server error during account linking" },
      500,
    );
  }
};

export const loginUser = async (
  c: Context<
    any,
    any,
    { in: { json: LoginSchema }; out: { json: LoginSchema } }
  >,
) => {
  const body = c.req.valid("json");

  try {
    // Every extra field named here MUST keep its own "+" prefix. Mongoose's
    // select() treats a mix of "+hiddenField" with any plain (unprefixed)
    // field name as a full inclusion-mode projection — i.e. ONLY the named
    // fields (+ _id) come back, silently dropping every other default
    // field (provider, email, ...). That previously made `user.provider`
    // undefined here, so the very next check ("not credentials provider")
    // rejected every single login, 2FA or not, with a generic "Invalid
    // email or password" — caught via live-browser verification, not by
    // the (mocked-User) unit tests, which never exercise real projection
    // behavior. twoFactorEnabled needs no prefix at all: it's a normal
    // (non select:false) field, already present on the default projection.
    const user = await User.findOne({ email: body.email }).select(
      "+password +twoFactorSecret +twoFactorBackupCodes",
    );

    if (!user || user.provider !== "credentials" || !user.password) {
      return c.json({ message: "Invalid email or password" }, 401);
    }

    const isPasswordCorrect = await argon2.verify(user.password, body.password);

    if (!isPasswordCorrect) {
      return c.json({ message: "Invalid email or password" }, 401);
    }

    if (user.twoFactorEnabled) {
      // Password alone is correct but not sufficient — tell the caller a
      // second factor is needed rather than logging in. A 200 here (not an
      // error status) since this isn't a failure, it's the expected next
      // step; NextAuth's authorize() (route.ts) checks this flag itself and
      // throws its own distinct error so the frontend can tell "need a
      // code" apart from "wrong password".
      if (!body.twoFactorCode) {
        return c.json({ requiresTwoFactor: true }, 200);
      }

      const totpOk = user.twoFactorSecret
        ? await verifyTotpCode(user.twoFactorSecret, body.twoFactorCode)
        : false;

      if (!totpOk) {
        const remainingBackupCodes = await verifyAndConsumeBackupCode(
          user.twoFactorBackupCodes ?? [],
          body.twoFactorCode,
        );
        if (remainingBackupCodes === null) {
          return c.json({ message: "Invalid two-factor code" }, 401);
        }
        user.twoFactorBackupCodes = remainingBackupCodes;
        await user.save();
      }
    }

    const userObject = user.toObject();
    delete userObject.password;
    delete userObject.twoFactorSecret;
    delete userObject.twoFactorBackupCodes;

    return c.json({ user: userObject });
  } catch (error) {
    console.error("Login Error:", error);
    return c.json({ message: "Internal server error during login" }, 500);
  }
};
