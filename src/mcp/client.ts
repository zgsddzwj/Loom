/**
 * MCP (Model Context Protocol) stdio client.
 *
 * Transport: child process + newline-delimited JSON-RPC 2.0 (the stdio
 * transport of the MCP spec). One process per server for the session.
 * Remote tools are bridged into the normal tool registry — so their results
 * are pruned, permission-gated and journaled like every other tool result.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import { LOOM_VERSION } from "../log/eventlog.js";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpToolInfo {
  server: string;
  originalName: string;
  name: string; // mcp__<server>__<tool>
  description: string;
  inputSchema: Record<string, unknown>;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class McpClient {
  private proc: ChildProcess;
  private nextId = 0;
  private pending = new Map<number, Pending>();
  closed = false;

  private constructor(readonly server: string) {
    // initialized lazily in connect()
    this.proc = null as unknown as ChildProcess;
  }

  static async connect(server: string, cfg: McpServerConfig): Promise<McpClient> {
    const client = new McpClient(server);
    client.proc = spawn(cfg.command, cfg.args ?? [], {
      env: { ...process.env, ...(cfg.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    client.proc.on("exit", () => {
      client.closed = true;
      for (const [, p] of client.pending) {
        p.reject(new Error(`MCP server "${server}" exited`));
      }
      client.pending.clear();
    });
    client.proc.on("error", (err) => {
      client.closed = true;
      for (const [, p] of client.pending) p.reject(new Error(`MCP server "${server}": ${err.message}`));
      client.pending.clear();
    });
    client.startReading();

    const init = (await client.request(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "loom", version: LOOM_VERSION },
      },
      15_000,
    )) as Record<string, unknown>;
    client.notify("notifications/initialized", {});
    return client;
  }

  private startReading() {
    const rl = readline.createInterface({ input: this.proc.stdout! });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      // Responses to our requests. Server-initiated requests/notifications
      // are ignored for now (ping/roots); servers tolerate that.
      if (typeof msg.id === "number" && (msg.result !== undefined || msg.error !== undefined)) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`MCP error: ${msg.error.message ?? JSON.stringify(msg.error)}`));
        else p.resolve(msg.result);
      }
    });
  }

  private write(msg: unknown): void {
    if (this.closed) throw new Error(`MCP server "${this.server}" is closed`);
    this.proc.stdin!.write(JSON.stringify(msg) + "\n");
  }

  async request(method: string, params: unknown, timeoutMs = 120_000): Promise<unknown> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} to "${this.server}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  notify(method: string, params: unknown): void {
    try {
      this.write({ jsonrpc: "2.0", method, params });
    } catch {
      /* notifications are best-effort */
    }
  }

  async listTools(): Promise<McpToolInfo[]> {
    type ToolsResult = { tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> };
    const result = (await this.request("tools/list", {}, 30_000)) as ToolsResult | undefined;
    const tools = result?.tools ?? [];
    return tools.map((t) => ({
      server: this.server,
      originalName: t.name,
      name: `mcp__${this.server}__${t.name}`,
      description: t.description ?? `Tool "${t.name}" from MCP server "${this.server}".`,
      inputSchema: t.inputSchema ?? { type: "object", properties: {} },
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = (await this.request("tools/call", { name, arguments: args })) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    const text = (result?.content ?? [])
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n");
    if (result?.isError) {
      throw new Error(text || `MCP tool "${name}" returned an error`);
    }
    return text || `(MCP tool "${name}" returned no text content)`;
  }

  close(): void {
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("client closed"));
    }
    this.pending.clear();
    try {
      this.proc.stdin?.end();
      this.proc.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
}
