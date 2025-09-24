import { z } from "zod";

export const registerSchema = z.object({
  name: z.string().min(3, "Name must be at least 3 characters"),
  email: z.string().email("Invalid email address"),
  password: z.string().min(6, "Password must be at least 6 characters"),
  profilePic: z.instanceof(File).optional(),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

export const providerLoginSchema = z.object({
  email: z.string().email(),
  name: z.string(),
  profilePic: z.string().url().optional(),
  provider: z.string(),
  providerAccountId: z.string(),
});

export const linkProviderSchema = z.object({
  userId: z.string(),
  provider: z.string(),
  providerAccountId: z.string(),
});

export type RegisterSchema = z.infer<typeof registerSchema>;
export type LoginSchema = z.infer<typeof loginSchema>;
export type ProviderLoginSchema = z.infer<typeof providerLoginSchema>;
export type LinkProviderSchema = z.infer<typeof linkProviderSchema>;
