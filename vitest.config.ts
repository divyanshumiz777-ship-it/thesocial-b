import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    globals: true,
    testTimeout: 10000,
    // Running test files in parallel (the default "forks" pool) spawns
    // enough concurrent argon2 hashing (password + 2FA backup codes, each
    // ~64MiB memory-hard by default) to reliably OOM-crash the full suite
    // on a normal dev machine. Sequential file execution costs a few
    // seconds; a crashed test run costs more.
    fileParallelism: false,
  },
});
