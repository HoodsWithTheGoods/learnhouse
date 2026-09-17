import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CHECKPOINT_SCHEMA_VERSION,
  readPinnedCheckpoint,
  validateCheckpoint,
} from "../src/checkpoint.js";
import type { RuntimeConfiguration } from "../src/config.js";

function checkpoint(overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  };
}

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "learning-context-mcp-"));
}

function configuration(root: string, checkpointPath = "learning-context.json"): RuntimeConfiguration {
  return {
    baseUrl: "http://127.0.0.1:3999",
    apiToken: "test-token",
    orgSlug: "test-org",
    userId: 42,
    courseUuid: "course_demo",
    workspaceRoot: root,
    checkpointPath,
    missing: [],
  };
}

test("the checkpoint contract rejects unknown fields and oversized learner text", () => {
  assert.throws(
    () => validateCheckpoint(checkpoint({ unexpected: "value" })),
    /invalid_checkpoint/,
  );
  assert.throws(
    () => validateCheckpoint(checkpoint({ artifact_summary: "x".repeat(4_001) })),
    /invalid_checkpoint/,
  );
});

test("the bridge reads only the configured file under the configured workspace", async () => {
  const root = await workspace();
  try {
    const config = configuration(root);
    await writeFile(join(root, "learning-context.json"), JSON.stringify(checkpoint()), "utf8");
    const loaded = await readPinnedCheckpoint(config);
    assert.deepEqual(loaded, checkpoint());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the bridge rejects a checkpoint path outside the configured workspace", async () => {
  const root = await workspace();
  try {
    await assert.rejects(
      readPinnedCheckpoint(configuration(root, "../outside.json")),
      /checkpoint_path_invalid/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the bridge rejects a checkpoint symlink even when its target is readable", async () => {
  const root = await workspace();
  const outside = await workspace();
  try {
    const target = join(outside, "checkpoint.json");
    await writeFile(target, JSON.stringify(checkpoint()), "utf8");
    await symlink(target, join(root, "learning-context.json"));
    await assert.rejects(readPinnedCheckpoint(configuration(root)), /checkpoint_path_invalid/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
