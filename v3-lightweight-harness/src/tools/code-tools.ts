import { ToolResult } from "../schemas/tool.js";
import { readMockJson } from "./data.js";

type CodeAnswer = {
  summary: string;
  file: string;
  method: string;
  line: number;
  fix: string;
};

export async function askCodebase(input: {
  codebasePath: string;
  question: string;
}): Promise<ToolResult> {
  const data = await readMockJson<Record<string, CodeAnswer>>("mock-codebase-answers.json");
  const answer = data[input.codebasePath];

  if (!answer) {
    return {
      status: "empty",
      summary: `代码库无 mock 答案: ${input.codebasePath}`,
      outputSummary: { codebasePath: input.codebasePath }
    };
  }

  return {
    status: "ok",
    summary: answer.summary,
    data: answer,
    outputSummary: {
      codebasePath: input.codebasePath,
      file: answer.file,
      method: answer.method,
      line: answer.line
    }
  };
}
