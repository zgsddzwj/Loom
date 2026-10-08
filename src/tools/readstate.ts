/**
 * Read-state tracking: mechanically enforced "read before edit".
 *
 * The harness — not the model's discipline — guarantees that a file is only
 * edited after it has been read in this session and has not changed on disk
 * since. Blind edits are impossible by construction.
 */

import * as fs from "node:fs";
import { ToolError } from "./errors.js";

interface ReadRecord {
  mtimeMs: number;
  size: number;
}

export class ReadState {
  private map = new Map<string, ReadRecord>();

  record(p: string): void {
    try {
      const st = fs.statSync(p);
      this.map.set(p, { mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      /* recording a file that disappeared is a no-op */
    }
  }

  has(p: string): boolean {
    return this.map.has(p);
  }

  private assertUnchanged(p: string): void {
    let st: fs.Stats;
    try {
      st = fs.statSync(p);
    } catch {
      throw new ToolError(`File ${p} no longer exists on disk. Read it again (or recreate it).`);
    }
    const rec = this.map.get(p)!;
    if (st.mtimeMs !== rec.mtimeMs || st.size !== rec.size) {
      throw new ToolError(
        `File ${p} changed on disk since it was last read. Read it again before editing.`,
      );
    }
  }

  /** Edit path: must have been read, and must not have changed since. */
  assertEditable(p: string): void {
    if (!this.map.has(p)) {
      throw new ToolError(
        `File ${p} has not been read in this session. Use the read tool first — ` +
          `Loom mechanically blocks editing unread files.`,
      );
    }
    this.assertUnchanged(p);
  }

  /** Write path: new files are fine; overwriting requires a prior read. */
  assertWritable(p: string): void {
    if (!fs.existsSync(p)) return;
    if (!this.map.has(p)) {
      throw new ToolError(
        `File ${p} exists but has not been read in this session. Read it before overwriting.`,
      );
    }
    this.assertUnchanged(p);
  }
}
