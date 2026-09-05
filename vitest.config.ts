import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@galaxy-mcp-service/protocol": fileURLToPath(new URL("./packages/protocol/src/index.ts", import.meta.url)),
    },
  },
  test: {
    fileParallelism: false,
  },
});
