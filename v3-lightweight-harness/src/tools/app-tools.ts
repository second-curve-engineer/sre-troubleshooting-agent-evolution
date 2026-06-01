// 应用解析工具：把用户输入中的服务别名映射为标准 app/codebase 元数据。
import { AppInfo, AppInfoSchema } from "../schemas/app.js";
import { ToolResult } from "../schemas/tool.js";
import { readMockJson } from "./data.js";

function normalize(value: string): string {
  return value.toLowerCase().replace(/[\s_-]+/g, "");
}

export async function resolveApp(input: { query: string }): Promise<ToolResult> {
  const apps = (await readMockJson<unknown[]>("app-registry.json")).map((item) =>
    AppInfoSchema.parse(item)
  );
  const query = normalize(input.query);
  const app = apps.find((candidate: AppInfo) => {
    const keys = [
      candidate.appId,
      candidate.appName,
      candidate.realName,
      candidate.systemName,
      ...candidate.aliases
    ].map(normalize);
    return keys.some((key) => query.includes(key) || key.includes(query));
  });

  if (!app) {
    return {
      status: "empty",
      summary: `未能解析应用: ${input.query}`,
      outputSummary: { query: input.query }
    };
  }

  return {
    status: "ok",
    summary: `应用解析成功: ${app.appId}`,
    data: app,
    outputSummary: {
      appId: app.appId,
      appName: app.appName,
      codebasePath: app.codebasePath
    }
  };
}
