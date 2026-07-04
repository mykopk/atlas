import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@myko/types": path.resolve(__dirname, "../types/src"),
      "@myko/types/db": path.resolve(__dirname, "../types/src/db"),
      "@myko/errors": path.resolve(__dirname, "../errors/src"),
      "@myko/logger": path.resolve(__dirname, "../logger/src"),
      "@myko/config": path.resolve(__dirname, "../config/src"),
      "@utils": path.resolve(__dirname, "src/utils"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
