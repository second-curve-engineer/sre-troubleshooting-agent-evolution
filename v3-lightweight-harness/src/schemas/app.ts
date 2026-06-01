// App schema：定义服务元数据结构，用于应用解析工具和后续代码库定位。
import { z } from "zod";

export const AppInfoSchema = z.object({
  appId: z.string(),
  systemName: z.string(),
  appName: z.string(),
  realName: z.string(),
  codebasePath: z.string(),
  aliases: z.array(z.string()).default([])
});

export type AppInfo = z.infer<typeof AppInfoSchema>;
