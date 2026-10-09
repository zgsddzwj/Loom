/**
 * Bridge MCP server tools into the tool registry. Bridged tools are
 * NON-readonly: they hit the permission engine like any other side-effecting
 * tool (default: ask; headless: fail-closed), and their results flow through
 * pruning + the event log like everything else.
 */

import type { ToolDef } from "../tools/registry.js";
import { McpClient, type McpToolInfo } from "./client.js";

export function bridgeTool(client: McpClient, info: McpToolInfo): ToolDef {
  return {
    name: info.name,
    description: info.description,
    readonly: false,
    inputSchema: info.inputSchema,
    async execute(input) {
      return client.callTool(info.originalName, input as Record<string, unknown>);
    },
  };
}

export function bridgeAllTools(client: McpClient, tools: McpToolInfo[]): ToolDef[] {
  return tools.map((t) => bridgeTool(client, t));
}
