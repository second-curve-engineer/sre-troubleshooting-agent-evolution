// Trace Store：把一次 run 的状态固化为 JSON，供复盘、eval 和后续 replay 使用。
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TRACE_DIR } from "../config/paths.js";
import { RunTrace, RunTraceSchema } from "../schemas/trace.js";

export type TraceListItem = {
  runId: string;
  createdAt: string;
  status: string;
  route?: string;
  problemType?: string;
  confidence?: string;
  filePath: string;
};

export class TraceStore {
  async save(trace: RunTrace): Promise<string> {
    await mkdir(TRACE_DIR, { recursive: true });
    const filePath = join(TRACE_DIR, `${trace.run.runId}.json`);
    await writeFile(filePath, JSON.stringify(trace, null, 2), "utf8");
    return filePath;
  }

  async read(runId: string): Promise<RunTrace> {
    const safeRunId = runId.replace(/[^a-zA-Z0-9_-]/g, "");
    const content = await readFile(join(TRACE_DIR, `${safeRunId}.json`), "utf8");
    return RunTraceSchema.parse(JSON.parse(content));
  }

  async list(limit = 50): Promise<TraceListItem[]> {
    await mkdir(TRACE_DIR, { recursive: true });
    const files = (await readdir(TRACE_DIR)).filter((file) => file.endsWith(".json"));
    const items = await Promise.all(
      files.map(async (file) => {
        const filePath = join(TRACE_DIR, file);
        const fileStat = await stat(filePath);
        return { file, filePath, mtimeMs: fileStat.mtimeMs };
      })
    );

    const traces: TraceListItem[] = [];
    for (const item of items.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit)) {
      try {
        const trace = RunTraceSchema.parse(JSON.parse(await readFile(item.filePath, "utf8")));
        traces.push({
          runId: trace.run.runId,
          createdAt: trace.createdAt,
          status: trace.run.status,
          route: trace.run.decision?.route,
          problemType: trace.run.decision?.problemType,
          confidence: trace.run.finalReport?.confidence,
          filePath: item.filePath
        });
      } catch {
        // 跳过损坏或非当前 schema 的 trace 文件，避免列表 API 整体失败。
      }
    }
    return traces;
  }
}
