/**
 * Bash tools: bash + bash_output.
 *
 * dsh design: a command that exceeds its timeout is NOT killed — it becomes
 * a background job whose output keeps flowing to a file. The model polls it
 * with bash_output. Long builds and dev servers survive.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { ToolError } from "./errors.js";
import type { ToolDef, ToolContext } from "./registry.js";

let jobCounter = 0;

export class Job {
  readonly id: string;
  readonly command: string;
  readonly startedAt = Date.now();
  proc: ChildProcess;
  readonly outFile: string;
  done = false;
  exitCode: number | null = null;

  constructor(command: string, cwd: string, artifactsDir: string) {
    this.command = command;
    this.id = `job${++jobCounter}-${Date.now().toString(36)}`;
    this.outFile = path.join(artifactsDir, `${this.id}.log`);
    const fd = fs.openSync(this.outFile, "a");
    const shell = process.env.SHELL || "/bin/bash";
    this.proc = spawn(shell, ["-c", command], { cwd, stdio: ["ignore", fd, fd] });
    this.proc.on("exit", (code) => {
      this.done = true;
      this.exitCode = code;
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    });
    this.proc.on("error", (err) => {
      fs.writeSync(fd, `\n[loom] process error: ${err.message}\n`);
      this.done = true;
      this.exitCode = 127;
    });
  }

  output(): string {
    try {
      return fs.readFileSync(this.outFile, "utf8");
    } catch {
      return "";
    }
  }

  finalText(): string {
    const secs = ((Date.now() - this.startedAt) / 1000).toFixed(1);
    return `exit code: ${this.exitCode}\nduration: ${secs}s\n--- output ---\n${this.output()}`;
  }

  async wait(timeoutMs: number): Promise<string> {
    const start = Date.now();
    while (!this.done) {
      if (Date.now() - start >= timeoutMs) {
        return JSON.stringify(
          {
            job_id: this.id,
            status: "running",
            note: `Command exceeded ${timeoutMs} ms and was detached (NOT killed). Poll it with bash_output(job_id="${this.id}").`,
            partial_output: this.output().slice(-2000),
          },
          null,
          2,
        );
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return this.finalText();
  }
}

export const bashTool: ToolDef = {
  name: "bash",
  description:
    "Execute a shell command in the workspace directory (each call runs a fresh shell — " +
    "state like cd or exported vars does not persist). Commands exceeding timeout_ms are " +
    "NOT killed; they detach to a background job you can poll with bash_output. " +
    "Describe destructive or hard-to-reverse commands clearly; they may require user approval.",
  readonly: false,
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to execute." },
      timeout_ms: { type: "number", description: "Timeout before detaching to a background job (default 120000)." },
    },
    required: ["command"],
  },
  async execute(input, ctx: ToolContext) {
    const command = String(input.command ?? "");
    if (!command.trim()) throw new ToolError("Empty command.");
    const timeout = Math.max(1000, Number(input.timeout_ms ?? 120_000));
    const job = new Job(command, ctx.cwd, ctx.artifacts.dir);
    ctx.jobs.set(job.id, job);
    return job.wait(timeout);
  },
};

export const bashOutputTool: ToolDef = {
  name: "bash_output",
  description:
    "Poll a background job started by bash. Returns its accumulated output; " +
    "when the job exits, includes the exit code.",
  readonly: true,
  inputSchema: {
    type: "object",
    properties: { job_id: { type: "string", description: "Job id returned by bash." } },
    required: ["job_id"],
  },
  async execute(input, ctx: ToolContext) {
    const job = ctx.jobs.get(String(input.job_id ?? ""));
    if (!job) throw new ToolError(`No such job. Known jobs: ${[...ctx.jobs.keys()].join(", ") || "(none)"}`);
    if (!job.done) {
      return JSON.stringify(
        { job_id: job.id, status: "running", output_so_far: job.output().slice(-4000) },
        null,
        2,
      );
    }
    return job.finalText();
  },
};
