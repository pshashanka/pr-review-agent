import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["eval/**/*.test.ts"],
    // Model calls are slow; one case at a time keeps the output readable.
    fileParallelism: false,
  },
});
