import { defineConfig } from "vitest/config";
import { fileURLToPath } from "url";

export default defineConfig({
  resolve: {
    // main-process modules import electron for types or unused helpers; tests run in plain Node
    alias: { electron: fileURLToPath(new URL("./test/stubs/electron.ts", import.meta.url)) },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    setupFiles: ["test/setup.ts"],
    pool: "forks", // node-pty is native, and tests change HOME per file
    testTimeout: 20_000,
  },
});
