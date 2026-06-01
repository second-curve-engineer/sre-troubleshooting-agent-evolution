// Trace Store：把一次 run 的状态固化为 JSON，供复盘、eval 和后续 replay 使用。
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TRACE_DIR } from "../config/paths.js";
import { RunTrace } from "../schemas/trace.js";

export class TraceStore {
  async save(trace: RunTrace): Promise<string> {
    await mkdir(TRACE_DIR, { recursive: true });
    const filePath = join(TRACE_DIR, `${trace.run.runId}.json`);
    await writeFile(filePath, JSON.stringify(trace, null, 2), "utf8");
    return filePath;
  }
}
