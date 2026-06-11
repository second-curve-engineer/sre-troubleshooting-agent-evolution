// PendingRunStore：持久化 waiting_approval 状态，使审批可跨进程恢复。
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { PENDING_RUN_DIR } from "../config/paths.js";
import { RunState, RunStateSchema } from "../schemas/run.js";

const PendingRunRecordSchema = z.object({
  version: z.literal("v1"),
  savedAt: z.string(),
  approvalId: z.string(),
  state: RunStateSchema
});

export type PendingRunRecord = z.infer<typeof PendingRunRecordSchema>;

function assertSafeApprovalId(approvalId: string): void {
  if (!/^approval-[a-zA-Z0-9_-]+$/.test(approvalId)) {
    throw new Error(`invalid approval id: ${approvalId}`);
  }
}

export class PendingRunStore {
  constructor(private readonly directory = PENDING_RUN_DIR) {}

  async save(state: RunState): Promise<string> {
    if (state.status !== "waiting_approval" || !state.pendingApprovalId) {
      throw new Error("only waiting_approval state can be stored as pending");
    }
    assertSafeApprovalId(state.pendingApprovalId);
    const record = PendingRunRecordSchema.parse({
      version: "v1",
      savedAt: new Date().toISOString(),
      approvalId: state.pendingApprovalId,
      state
    });

    await mkdir(this.directory, { recursive: true });
    const filePath = this.filePath(record.approvalId);
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(record, null, 2), "utf8");
    await rename(temporaryPath, filePath);
    return filePath;
  }

  async read(approvalId: string): Promise<PendingRunRecord | null> {
    assertSafeApprovalId(approvalId);
    try {
      const content = await readFile(this.filePath(approvalId), "utf8");
      const record = PendingRunRecordSchema.parse(JSON.parse(content));
      if (
        record.approvalId !== approvalId ||
        record.state.pendingApprovalId !== approvalId ||
        record.state.status !== "waiting_approval"
      ) {
        throw new Error(`pending record ${approvalId} is inconsistent`);
      }
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async delete(approvalId: string): Promise<void> {
    assertSafeApprovalId(approvalId);
    await rm(this.filePath(approvalId), { force: true });
  }

  private filePath(approvalId: string): string {
    return join(this.directory, `${approvalId}.json`);
  }
}

export class PendingRunNotFoundError extends Error {
  constructor(readonly approvalId: string) {
    super(`pending approval ${approvalId} not found`);
  }
}
