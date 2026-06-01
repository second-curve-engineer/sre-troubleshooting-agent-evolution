// Mock 数据加载层：集中读取脱敏 JSON 数据，保持 tool adapter 逻辑简单。
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MOCK_DATA_DIR } from "../config/paths.js";

export async function readMockJson<T>(fileName: string): Promise<T> {
  const raw = await readFile(join(MOCK_DATA_DIR, fileName), "utf8");
  return JSON.parse(raw) as T;
}
