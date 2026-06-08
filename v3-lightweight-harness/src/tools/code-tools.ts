// 代码问答工具：根据异常栈定位源码文件、读取上下文行，再调用 LLM 分析根因。
// 定位阶段（栈帧解析 + glob 文件搜索 + 文件读取）是确定性的；根因分析阶段才用 LLM。
// 无 LLM / 无源码路径 / 文件不存在时，自动降级为 mock JSON 答案。
import { glob, readFile } from "node:fs/promises";
import { join, normalize, resolve } from "node:path";
import { ToolResult } from "../schemas/tool.js";
import { readMockJson } from "./data.js";
import { ROOT_DIR } from "../config/paths.js";
import { loadLlmConfig } from "../config/env.js";
import { OpenAiClient } from "../llm/openai-client.js";
import { sanitizeForLlm } from "../security/llm-safety.js";

// ──────────────────────────────────────────────
// 1. 栈帧解析
// ──────────────────────────────────────────────

export type StackFrame = {
  className: string;   // e.g. com.example.inventory.InventoryService
  method: string;      // e.g. reserve
  file: string;        // e.g. InventoryService.java  ← 直接来自栈帧，不需要从类名推导
  line: number;        // e.g. 87
};

/**
 * 解析 Java 风格的异常栈字符串，返回栈帧数组（顶层帧优先）。
 *
 * 支持格式：
 *   com.example.inventory.InventoryService.reserve(InventoryService.java:87)
 *   com.example.order.OrderService$$Lambda$1.apply(OrderService.java:55)  ← Lambda
 *   java.lang.Thread.run(Thread.java:833)                                 ← JDK 内部帧（会被过滤）
 */
export function parseJavaStackFrames(stackTrace: string): StackFrame[] {
  const frames: StackFrame[] = [];
  const frameRegex = /^\s*(?:at\s+)?([a-zA-Z_$][\w$.]*)\.([\w$<>]+)\(([^:)]+\.java):(\d+)\)\s*$/;

  for (const line of stackTrace.split("\n")) {
    const match = frameRegex.exec(line.trim());
    if (!match) continue;

    const [, rawClassName, method, file, lineStr] = match;
    if (isFrameworkFrame(rawClassName)) continue;

    // Lambda 类名去掉 $$Lambda$xxx 后缀
    const className = rawClassName.replace(/\$\$Lambda\$\d+.*$/, "");
    frames.push({ className, method, file, line: parseInt(lineStr, 10) });
  }

  return frames;
}

// JDK / Spring / Tomcat 等内部帧的包前缀，过滤掉减少噪音
const FRAMEWORK_PREFIXES = [
  "java.", "javax.", "sun.", "com.sun.",
  "org.springframework.", "org.apache.", "org.tomcat.",
  "com.netflix.", "io.netty."
];

function isFrameworkFrame(className: string): boolean {
  return FRAMEWORK_PREFIXES.some((prefix) => className.startsWith(prefix));
}

// ──────────────────────────────────────────────
// 2. glob 文件搜索 + 文件读取
// ──────────────────────────────────────────────

/**
 * 在 sourceRoot 下用 glob 搜索指定文件名，返回所有匹配的绝对路径。
 *
 * 比从类名推导路径更健壮：
 *   - 适配非标准 Maven 目录结构（多模块、自定义 layout 等）
 *   - 同名类在不同子模块时返回多个候选，都读进来给 LLM 判断
 *   - 不依赖类名到路径的映射假设
 */
async function findSourceFiles(fileName: string, sourceRoot: string): Promise<string[]> {
  const safeRoot = normalize(sourceRoot);
  const matches: string[] = [];

  // node:fs/promises glob（Node 22+ 内置），pattern 限定在 sourceRoot 内
  for await (const relativePath of glob(`**/${fileName}`, { cwd: safeRoot })) {
    const absPath = resolve(safeRoot, relativePath);
    // 安全校验：确保 glob 结果仍在 sourceRoot 内，防止符号链接逃逸
    if (absPath.startsWith(safeRoot + "/") || absPath === safeRoot) {
      matches.push(absPath);
    }
  }

  return matches;
}

const CONTEXT_LINES = 35; // 目标行号上下各读取 N 行

export type FileSlice = {
  filePath: string;      // 实际读取的绝对路径
  relativeFile: string;  // 相对 sourceRoot 的路径，用于展示
  startLine: number;
  endLine: number;
  content: string;       // 截取的源码文本（带行号）
};

/**
 * 读取文件中目标行号周围的代码片段（行号 ± CONTEXT_LINES）。
 * absPath 由 findSourceFiles 返回，已做过安全校验，此处直接读取。
 */
async function readFileSlice(args: {
  absPath: string;
  sourceRoot: string;  // 仅用于计算展示用的 relativeFile
  targetLine: number;
}): Promise<FileSlice | null> {
  let raw: string;
  try {
    raw = await readFile(args.absPath, "utf8");
  } catch {
    return null;
  }

  const lines = raw.split("\n");
  const startLine = Math.max(1, args.targetLine - CONTEXT_LINES);
  const endLine = Math.min(lines.length, args.targetLine + CONTEXT_LINES);

  // 带行号格式化，方便 LLM 定位
  const numbered = lines
    .slice(startLine - 1, endLine)
    .map((line, i) => `${String(startLine + i).padStart(4, " ")} | ${line}`)
    .join("\n");

  return {
    filePath: args.absPath,
    relativeFile: args.absPath.slice(normalize(args.sourceRoot).length + 1),
    startLine,
    endLine,
    content: numbered
  };
}

// ──────────────────────────────────────────────
// 3. LLM 根因分析
// ──────────────────────────────────────────────

type MockCodeAnswer = {
  summary: string;
  file: string;
  method: string;
  line: number;
  fix: string;
};

async function analyzeWithLlm(args: {
  stackTrace: string;
  question: string;
  appId: string;
  slices: FileSlice[];
}): Promise<string> {
  const config = loadLlmConfig();
  if (config.mode !== "openai" || !config.apiKey) {
    throw new Error("LLM not configured");
  }

  const client = new OpenAiClient(config.baseUrl, config.apiKey);

  const sliceText = args.slices
    .map((s) => {
      const safe = sanitizeForLlm(s.content);
      return `=== ${s.relativeFile} (lines ${s.startLine}-${s.endLine}) ===\n${safe.text}`;
    })
    .join("\n\n");

  const safeStack = sanitizeForLlm(args.stackTrace);
  const safeQuestion = sanitizeForLlm(args.question);

  const systemPrompt = `你是 SRE 代码根因分析专家。根据提供的异常栈和相关源码，用中文回答：
1. 触发异常的直接原因（指出具体代码行）
2. 根本原因（为什么这行代码会出问题）
3. 修复建议（具体代码改动或设计改进）

回答简洁，限制在 200 字以内。`;

  const userPrompt = `## 异常栈
\`\`\`
${safeStack.text}
\`\`\`

## 问题
${safeQuestion.text}

## 相关源码
${sliceText}`;

  const result = await client.complete({
    model: config.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    timeoutMs: config.timeoutMs,
    temperature: 0,
    maxTokens: 400
  });

  return result.content;
}

// ──────────────────────────────────────────────
// 4. 主入口
// ──────────────────────────────────────────────

export async function askCodebase(input: {
  appId: string;
  codebasePath?: string;  // 源码根目录路径（相对 ROOT_DIR）；不填时降级为 mock
  question: string;
  stackTrace?: string;
}): Promise<ToolResult> {
  if (input.codebasePath && input.stackTrace) {
    return await realAskCodebase(input as Required<typeof input>);
  }
  return await mockAskCodebase(input.appId);
}

async function realAskCodebase(input: {
  appId: string;
  codebasePath: string;
  question: string;
  stackTrace: string;
}): Promise<ToolResult> {
  const absoluteSourceRoot = resolve(ROOT_DIR, input.codebasePath);

  // Step 1：解析栈帧，提取 { file, line } — 直接来自栈帧文本，无需推导路径
  const frames = parseJavaStackFrames(input.stackTrace);
  if (frames.length === 0) {
    return await mockAskCodebase(input.appId);
  }

  // Step 2：对每个栈帧，用 glob 在 sourceRoot 下搜索同名文件，再读取行范围切片
  // glob 搜索：适配任意目录结构；同名文件存在多个时全部读入
  const sliceResults = await Promise.all(
    frames.map(async (frame) => {
      const candidatePaths = await findSourceFiles(frame.file, absoluteSourceRoot);
      if (candidatePaths.length === 0) return { frame, slices: [] };

      const slices = (
        await Promise.all(
          candidatePaths.map((absPath) =>
            readFileSlice({ absPath, sourceRoot: absoluteSourceRoot, targetLine: frame.line })
          )
        )
      ).filter((s): s is FileSlice => s !== null);

      return { frame, slices };
    })
  );

  const allSlices = sliceResults.flatMap((r) => r.slices);
  if (allSlices.length === 0) {
    return await mockAskCodebase(input.appId);
  }

  // 主帧：第一个成功找到文件的帧
  const primaryResult = sliceResults.find((r) => r.slices.length > 0)!;
  const primaryFrame = primaryResult.frame;
  const primarySlice = primaryResult.slices[0];

  // Step 3：LLM 根因分析（语义）
  let analysis: string;
  let llmUsed = false;
  try {
    analysis = await analyzeWithLlm({
      stackTrace: input.stackTrace,
      question: input.question,
      appId: input.appId,
      slices: allSlices
    });
    llmUsed = true;
  } catch {
    const fileList = allSlices.map((s) => s.relativeFile).join(", ");
    analysis = `已定位源码文件：${fileList}。主异常位于 ${primaryFrame.file}:${primaryFrame.line} (${primaryFrame.method})。LLM 分析不可用，请手动检查上述文件。`;
  }

  return {
    status: "ok",
    summary: analysis,
    data: {
      frames: sliceResults.map((r) => ({
        className: r.frame.className,
        method: r.frame.method,
        file: r.frame.file,
        line: r.frame.line,
        filesFound: r.slices.length
      }))
    },
    outputSummary: {
      appId: input.appId,
      primaryFile: primarySlice.relativeFile,
      primaryMethod: primaryFrame.method,
      primaryLine: primaryFrame.line,
      framesFound: frames.length,
      filesRead: allSlices.length,
      llmUsed
    }
  };
}

async function mockAskCodebase(codebasePath: string): Promise<ToolResult> {
  const data = await readMockJson<Record<string, MockCodeAnswer>>("mock-codebase-answers.json");
  const answer = data[codebasePath];

  if (!answer) {
    return {
      status: "empty",
      summary: `代码库无 mock 答案: ${codebasePath}`,
      outputSummary: { codebasePath, mode: "mock" }
    };
  }

  return {
    status: "ok",
    summary: answer.summary,
    data: answer,
    outputSummary: {
      codebasePath,
      file: answer.file,
      method: answer.method,
      line: answer.line,
      mode: "mock"
    }
  };
}
