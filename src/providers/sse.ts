/** Minimal SSE line parser for streaming API responses. */

export async function* sseDataLines(res: Response): AsyncGenerator<string> {
  if (!res.body) throw new Error("Response has no body to stream");
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      let line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
}
