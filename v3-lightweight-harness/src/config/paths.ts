// 集中管理运行时路径，避免 trace/mock-data 等目录散落在业务代码里。
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));

export const ROOT_DIR = resolve(currentDir, "../..");
export const MOCK_DATA_DIR = resolve(ROOT_DIR, "mock-data");
export const TRACE_DIR = resolve(ROOT_DIR, process.env.TRACE_DIR ?? "traces");
export const PENDING_RUN_DIR = resolve(ROOT_DIR, process.env.PENDING_RUN_DIR ?? "pending-runs");
