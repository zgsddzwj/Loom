/**
 * Artifact store: spill large content outside the context window.
 *
 * Oversized tool results and compacted history are written here and
 * referenced by locator ("artifact:<filename>"). The recall tool reads them
 * back — so truncation and compaction are always reversible for the model.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export class ArtifactStore {
  private counter = 0;

  constructor(readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  spill(label: string, content: string): string {
    const safe = label.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 40) || "blob";
    const name = `${Date.now().toString(36)}-${++this.counter}-${safe}.json`;
    fs.writeFileSync(path.join(this.dir, name), content, "utf8");
    return `artifact:${name}`;
  }

  read(locator: string): string | null {
    if (!locator.startsWith("artifact:")) return null;
    const name = path.basename(locator.slice("artifact:".length));
    const p = path.join(this.dir, name);
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p, "utf8");
  }
}
