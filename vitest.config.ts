import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30000,
    // This suite spawns real child processes everywhere (bash jobs, MCP
    // servers, subagent loops, hooks). Serializing files avoids spawn storms
    // (EAGAIN under parallel load) on 2-core CI runners.
    fileParallelism: false,
  },
});
