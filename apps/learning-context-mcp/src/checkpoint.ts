import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { requireConfigured, type RuntimeConfiguration } from "./config.js";
import { asRecord, LearningContextMcpError } from "./types.js";

export const CHECKPOINT_SCHEMA_VERSION = "workspace_checkpoint_v1";
export const MAX_CHECKPOINT_BYTES = 16 * 1024;
export const MAX_OPEN_QUESTIONS = 12;

const STRING_LIMITS = {
  current_lesson: 200,
  status: 80,
  goal: 800,
  artifact_summary: 4_000,
  artifact_revision: 160,
  next_action: 800,
  updated_at: 80,
} as const;

const CHECKPOINT_FIELDS = new Set([
  "schema_version",
  "current_lesson",
  "status",
  "goal",
  "artifact_summary",
  "artifact_revision",
  "next_action",
  "open_questions",
  "updated_at",
]);

export type LearningCheckpoint = {
  schema_version: typeof CHECKPOINT_SCHEMA_VERSION;
  current_lesson: string;
  status: string;
  goal: string;
  artifact_summary: string;
  artifact_revision: string;
  next_action: string;
  open_questions: string[];
  updated_at: string;
};

function invalidCheckpoint(): never {
  throw new LearningContextMcpError("invalid_checkpoint");
}

function boundedString(value: unknown, limit: number): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > limit) {
    return invalidCheckpoint();
  }
  return value;
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative.length > 0 && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

/** Reject unknown fields and unbounded learner supplied text before it can leave the workspace. */
export function validateCheckpoint(value: unknown): LearningCheckpoint {
  const record = asRecord(value);
  if (!record) return invalidCheckpoint();
  const keys = Object.keys(record);
  if (keys.length !== CHECKPOINT_FIELDS.size || keys.some((key) => !CHECKPOINT_FIELDS.has(key))) {
    return invalidCheckpoint();
  }
  if (record.schema_version !== CHECKPOINT_SCHEMA_VERSION) return invalidCheckpoint();

  const openQuestions = record.open_questions;
  if (!Array.isArray(openQuestions) || openQuestions.length > MAX_OPEN_QUESTIONS) {
    return invalidCheckpoint();
  }
  const checkpoint: LearningCheckpoint = {
    schema_version: CHECKPOINT_SCHEMA_VERSION,
    current_lesson: boundedString(record.current_lesson, STRING_LIMITS.current_lesson),
    status: boundedString(record.status, STRING_LIMITS.status),
    goal: boundedString(record.goal, STRING_LIMITS.goal),
    artifact_summary: boundedString(record.artifact_summary, STRING_LIMITS.artifact_summary),
    artifact_revision: boundedString(record.artifact_revision, STRING_LIMITS.artifact_revision),
    next_action: boundedString(record.next_action, STRING_LIMITS.next_action),
    open_questions: openQuestions.map((item) => boundedString(item, 400)),
    updated_at: boundedString(record.updated_at, STRING_LIMITS.updated_at),
  };
  if (Number.isNaN(Date.parse(checkpoint.updated_at))) return invalidCheckpoint();
  if (Buffer.byteLength(JSON.stringify(checkpoint), "utf8") > MAX_CHECKPOINT_BYTES) {
    return invalidCheckpoint();
  }
  return checkpoint;
}

async function resolvePinnedCheckpointPath(
  configuration: RuntimeConfiguration,
  requireExisting: boolean,
): Promise<string> {
  requireConfigured(configuration);
  let root: string;
  try {
    const rootStat = await stat(configuration.workspaceRoot);
    if (!rootStat.isDirectory()) throw new Error("workspace is not a directory");
    root = await realpath(configuration.workspaceRoot);
  } catch {
    throw new LearningContextMcpError("checkpoint_path_invalid");
  }

  const candidate = path.resolve(root, configuration.checkpointPath);
  if (!isWithin(root, candidate)) {
    throw new LearningContextMcpError("checkpoint_path_invalid");
  }

  let parent: string;
  try {
    parent = await realpath(path.dirname(candidate));
  } catch {
    throw new LearningContextMcpError("checkpoint_path_invalid");
  }
  if (parent !== root && !isWithin(root, parent)) {
    throw new LearningContextMcpError("checkpoint_path_invalid");
  }

  try {
    const targetStat = await lstat(candidate);
    if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
      throw new LearningContextMcpError("checkpoint_path_invalid");
    }
    const resolved = await realpath(candidate);
    if (!isWithin(root, resolved)) {
      throw new LearningContextMcpError("checkpoint_path_invalid");
    }
    return resolved;
  } catch (error) {
    if (error instanceof LearningContextMcpError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" && !requireExisting) return candidate;
    throw new LearningContextMcpError(requireExisting ? "invalid_checkpoint" : "checkpoint_path_invalid");
  }
}

export async function readPinnedCheckpoint(
  configuration: RuntimeConfiguration,
): Promise<LearningCheckpoint> {
  const target = await resolvePinnedCheckpointPath(configuration, true);
  let bytes: Buffer;
  try {
    const targetStat = await stat(target);
    if (targetStat.size > MAX_CHECKPOINT_BYTES) return invalidCheckpoint();
    bytes = await readFile(target);
  } catch (error) {
    if (error instanceof LearningContextMcpError) throw error;
    return invalidCheckpoint();
  }
  if (bytes.byteLength > MAX_CHECKPOINT_BYTES) return invalidCheckpoint();
  try {
    return validateCheckpoint(JSON.parse(bytes.toString("utf8")));
  } catch (error) {
    if (error instanceof LearningContextMcpError) throw error;
    return invalidCheckpoint();
  }
}
