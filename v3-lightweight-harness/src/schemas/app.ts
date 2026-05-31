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
