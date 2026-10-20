import { defineConfig } from "vitest/config";
import { fileURLToPath } from "url";

// A run of the leaky fixtures beside it under the suite's own setup and global
// setup, for test/leakGuard.test.ts: what they leave behind must be reported.
export default defineConfig({
  root: fileURLToPath(new URL("../../..", import.meta.url)),
  test: {
    include: ["test/fixtures/leaks/*.fixture.ts"],
    environment: "node",
    setupFiles: ["test/setup.ts"],
    globalSetup: ["test/globalSetup.ts"],
    pool: "forks",
  },
});
