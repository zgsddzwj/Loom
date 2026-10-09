import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { McpClient } from "../src/mcp/client.js";
import { bridgeAllTools } from "../src/mcp/bridge.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { ArtifactStore } from "../src/context/artifacts.js";
import { ReadState } from "../src/tools/readstate.js";
import type { ToolContext } from "../src/tools/registry.js";

/** A minimal MCP stdio server used as a REAL child process for the test. */
const SERVER_JS = `
import * as readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");
rl.on("line", (line) => {
  let req; try { req = JSON.parse(line); } catch { return; }
  if (req.method === "initialize") {
    send({ jsonrpc: "2.0", id: req.id, result: {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "test-server", version: "0.0.1" },
    }});
  } else if (req.method === "tools/list") {
    send({ jsonrpc: "2.0", id: req.id, result: { tools: [{
      name: "echo",
      description: "Echo text back",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    }] }});
  } else if (req.method === "tools/call") {
    const text = req.params?.arguments?.text ?? "(nothing)";
    if (text === "BOOM") {
      send({ jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: "kaboom" }], isError: true } });
    } else {
      send({ jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: "echo: " + text }] } });
    }
  } else if (req.id !== undefined) {
    send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "no such method: " + req.method } });
  }
});
`;

function writeServer(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-mcp-"));
  const file = path.join(dir, "test-server.mjs");
  fs.writeFileSync(file, SERVER_JS, "utf8");
  return file;
}

function toolContext(): ToolContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-mcp-ctx-"));
  return {
    cwd: dir,
    sessionDir: dir,
    artifacts: new ArtifactStore(path.join(dir, "artifacts")),
    readState: new ReadState(),
    jobs: new Map(),
    io: {},
  };
}

describe("MCP stdio client (real child process)", () => {
  it("connects, lists tools, bridges them into the registry, and calls them", async () => {
    const server = writeServer();
    const client = await McpClient.connect("test", { command: process.execPath, args: [server] });
    try {
      const tools = await client.listTools();
      expect(tools.length).toBe(1);
      expect(tools[0].name).toBe("mcp__test__echo");

      const ctx = toolContext();
      const defs = bridgeAllTools(client, tools);
      expect(defs[0].readonly).toBe(false); // MCP tools hit the permission engine
      const registry = new ToolRegistry(defs, ctx);

      const ok = await registry.execute({ id: "m1", name: "mcp__test__echo", input: { text: "hi" } });
      expect(ok.isError).toBe(false);
      expect(ok.content).toBe("echo: hi");

      const boom = await registry.execute({ id: "m2", name: "mcp__test__echo", input: { text: "BOOM" } });
      expect(boom.isError).toBe(true);
      expect(boom.content).toContain("kaboom");

      // MCP results flow through pruning like any other tool result
      const pruned = await new ToolRegistry(defs, ctx, 5).execute({
        id: "m3",
        name: "mcp__test__echo",
        input: { text: "a-very-long-echo-payload-exceeding-prune-bytes" },
      });
      expect(pruned.content).toContain("recall");
      expect(pruned.locator).toMatch(/^artifact:/);
    } finally {
      client.close();
    }
  });

  it("fails loudly when the server command does not exist", async () => {
    await expect(
      McpClient.connect("bad", { command: "/nonexistent/loom-mcp-server-binary" }),
    ).rejects.toThrow(/bad/);
  });
});
