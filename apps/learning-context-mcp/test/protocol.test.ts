import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { CHECKPOINT_SCHEMA_VERSION } from "../src/checkpoint.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsxCli = resolve(packageRoot, "node_modules/tsx/dist/cli.mjs");
const entrypoint = resolve(packageRoot, "src/index.ts");

type JsonRpcResponse = {
  id?: number;
  result?: {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
    tools?: Array<{
      name?: string;
      annotations?: {
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
        openWorldHint?: boolean;
      };
    }>;
  };
  error?: unknown;
};

function checkpoint() {
  return {
    schema_version: CHECKPOINT_SCHEMA_VERSION,
    current_lesson: "Lesson one",
    status: "in_progress",
    goal: "Build a focused learner workspace.",
    artifact_summary: "A first draft exists.",
    artifact_revision: "draft-1",
    next_action: "Test the checkpoint boundary.",
    open_questions: ["What comes next?"],
    updated_at: "2026-09-17T12:00:00Z",
  };
}

test("the STDIO server advertises exactly the focused tools and reads the local checkpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "learning-context-protocol-"));
  await writeFile(join(root, "learning-context.json"), JSON.stringify(checkpoint()), "utf8");
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [tsxCli, entrypoint], {
    cwd: packageRoot,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      NODE_ENV: "test",
      LEARNING_CONTEXT_MCP_BASE_URL: "http://127.0.0.1:3999",
      LEARNING_CONTEXT_MCP_API_TOKEN: "test-token",
      LEARNING_CONTEXT_MCP_ORG_SLUG: "test-org",
      LEARNING_CONTEXT_MCP_USER_ID: "42",
      LEARNING_CONTEXT_MCP_COURSE_UUID: "course_demo",
      LEARNING_CONTEXT_MCP_WORKSPACE_ROOT: root,
      LEARNING_CONTEXT_MCP_CHECKPOINT_PATH: "learning-context.json",
    },
    stdio: "pipe",
  });

  const replies = new Map<number, (response: JsonRpcResponse) => void>();
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    const lines = stdout.split("\n");
    stdout = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const response = JSON.parse(line) as JsonRpcResponse;
      if (typeof response.id === "number") replies.get(response.id)?.(response);
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const request = (id: number, method: string, params: Record<string, unknown>) =>
    new Promise<JsonRpcResponse>((resolveReply, rejectReply) => {
      const timeout = setTimeout(
        () => rejectReply(new Error(`Timed out waiting for ${method}: ${stderr}`)),
        4_000,
      );
      replies.set(id, (response) => {
        clearTimeout(timeout);
        resolveReply(response);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

  try {
    const initialized = await request(1, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "protocol-test", version: "0.1.0" },
    });
    assert.equal(initialized.error, undefined);

    const listed = await request(2, "tools/list", {});
    assert.deepEqual(
      (listed.result?.tools ?? []).map((tool) => tool.name).sort(),
      [
        "get_assignment_feedback",
        "get_course_assignments",
        "get_learning_state",
        "get_local_checkpoint",
        "publish_checkpoint_draft",
      ],
    );
    const draft = (listed.result?.tools ?? []).find((tool) => tool.name === "publish_checkpoint_draft");
    assert.deepEqual(draft?.annotations, {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });

    const local = await request(3, "tools/call", {
      name: "get_local_checkpoint",
      arguments: {},
    });
    assert.equal(local.result?.isError, undefined);
    assert.equal(
      ((local.result?.structuredContent?.checkpoint as Record<string, unknown>) ?? {}).goal,
      "Build a focused learner workspace.",
    );
  } finally {
    child.kill("SIGTERM");
    await rm(root, { recursive: true, force: true });
  }
});
