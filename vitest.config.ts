import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    globals: false,
    pool: "forks",
  },
  resolve: {
    extensions: [".ts", ".js"],
  },
});
