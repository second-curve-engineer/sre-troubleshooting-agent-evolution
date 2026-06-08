// App schema：定义服务元数据结构，用于应用解析工具和后续代码库定位。
import { z } from "zod";

export const AppInfoSchema = z.object({
  appId: z.string(),
  systemName: z.string(),
  appName: z.string(),
  realName: z.string(),
  // 源码根目录路径。
  // 生产环境填真实路径；不填时 askCodebase 降级为 mock JSON 答案。
  codebasePath: z.string().optional(),
  aliases: z.array(z.string()).default([])
});

export type AppInfo = z.infer<typeof AppInfoSchema>;
