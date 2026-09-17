import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CHECKPOINT_SCHEMA_VERSION } from "../src/checkpoint.js";
import type { RuntimeConfiguration } from "../src/config.js";
import { LearningContextService } from "../src/service.js";

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

type Call = {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
  body: string;
};

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function json(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function startMockLearnHouse() {
  const calls: Call[] = [];
  const server = createServer(async (request, response) => {
    const body = await readRequestBody(request);
    calls.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      body,
    });

    if (request.method === "GET" && request.url === "/api/v1/admin/test-org/progress/42/course_demo") {
      return json(response, {
        course_uuid: "course_demo",
        user_id: 42,
        total_activities: 4,
        completed_activities: 1,
        completion_percentage: 25,
        completed_activity_ids: [100],
      });
    }
    if (request.method === "GET" && request.url === "/api/v1/assignments/course/course_demo") {
      return json(response, [
        {
          assignment_uuid: "assignment_demo",
          title: "Build your agent",
          description: "One bounded artifact",
          published: true,
          activity_uuid: "activity_demo",
          ungraded: true,
        },
      ]);
    }
    if (request.method === "GET" && request.url === "/api/v1/assignments/assignment_demo") {
      return json(response, {
        assignment_uuid: "assignment_demo",
        course_uuid: "course_demo",
        title: "Build your agent",
        description: "One bounded artifact",
        published: true,
        activity_uuid: "activity_demo",
        ungraded: true,
      });
    }
    if (request.method === "GET" && request.url === "/api/v1/assignments/assignment_demo/tasks") {
      return json(response, [
        {
          assignment_task_uuid: "checkpoint_task",
          title: "Workspace checkpoint",
          assignment_type: "CUSTOM",
          contents: { integration_type: "workspace_checkpoint_v1" },
        },
        {
          assignment_task_uuid: "reflection_task",
          title: "Reflection",
          assignment_type: "SHORT_ANSWER",
          contents: {},
        },
      ]);
    }
    if (request.method === "GET" && request.url === "/api/v1/assignments/assignment_demo/submissions/42") {
      return json(response, [
        {
          user_id: 42,
          grade: 0,
          overall_feedback: "Keep the scope small.",
          update_date: "2026-09-17T12:10:00Z",
        },
      ]);
    }
    if (
      request.method === "GET" &&
      request.url === "/api/v1/assignments/assignment_demo/tasks/checkpoint_task/submissions/user/42"
    ) {
      return json(response, {
        user_id: 42,
        grade: 0,
        task_submission_grade_feedback: "",
        update_date: "2026-09-17T12:10:00Z",
      });
    }
    if (
      request.method === "GET" &&
      request.url === "/api/v1/assignments/assignment_demo/tasks/reflection_task/submissions/user/42"
    ) {
      return json(response, {
        user_id: 42,
        grade: 0,
        task_submission_grade_feedback: "Name the next action.",
        update_date: "2026-09-17T12:10:00Z",
      });
    }
    if (
      request.method === "PUT" &&
      request.url === "/api/v1/assignments/assignment_demo/tasks/checkpoint_task/submissions?on_behalf_of_user_id=42"
    ) {
      return json(response, { assignment_task_submission_uuid: "draft_1" });
    }
    return json(response, { detail: "not found" }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock server has no TCP address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    calls,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "learning-context-service-"));
}

function configuration(root: string, baseUrl: string): RuntimeConfiguration {
  return {
    baseUrl,
    apiToken: "test-token",
    orgSlug: "test-org",
    userId: 42,
    courseUuid: "course_demo",
    workspaceRoot: root,
    checkpointPath: "learning-context.json",
    missing: [],
  };
}

test("the service uses pinned LearnHouse paths and the bearer token", async () => {
  const root = await workspace();
  const mock = await startMockLearnHouse();
  try {
    await writeFile(join(root, "learning-context.json"), JSON.stringify(checkpoint()), "utf8");
    const service = new LearningContextService(configuration(root, mock.baseUrl));
    const state = await service.getLearningState();
    assert.equal((state.progress as Record<string, unknown>).completion_percentage, 25);
    assert.equal((state.checkpoint as Record<string, unknown>).untrusted, true);
    assert.deepEqual(
      mock.calls.map((call) => call.url).sort(),
      [
        "/api/v1/admin/test-org/progress/42/course_demo",
        "/api/v1/assignments/course/course_demo",
      ].sort(),
    );
    assert.ok(mock.calls.every((call) => call.authorization === "Bearer test-token"));
  } finally {
    await mock.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the service reads pinned feedback and publishes the reviewed local checkpoint", async () => {
  const root = await workspace();
  const mock = await startMockLearnHouse();
  try {
    await writeFile(join(root, "learning-context.json"), JSON.stringify(checkpoint()), "utf8");
    const service = new LearningContextService(configuration(root, mock.baseUrl));
    const feedback = await service.getAssignmentFeedback({ assignmentUuid: "assignment_demo" });
    assert.deepEqual(feedback.overall_feedback, [
      { grade: 0, feedback: "Keep the scope small.", updated_at: "2026-09-17T12:10:00Z" },
    ]);
    assert.deepEqual(feedback.task_feedback, [
      {
        assignment_task_uuid: "reflection_task",
        grade: 0,
        feedback: "Name the next action.",
        updated_at: "2026-09-17T12:10:00Z",
      },
    ]);

    const saved = await service.publishCheckpointDraft({
      confirm: true,
      assignmentUuid: "assignment_demo",
      assignmentTaskUuid: "checkpoint_task",
    });
    assert.equal(saved.remote_draft_saved, true);
    assert.equal(saved.local_checkpoint_edited, false);
    assert.equal(saved.assignment_task_submission_uuid, "draft_1");
    const draftCall = mock.calls.find((call) => call.method === "PUT");
    assert.ok(draftCall);
    assert.deepEqual(JSON.parse(draftCall.body), { task_submission: checkpoint() });
  } finally {
    await mock.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the service refuses a draft when the task is not the configured checkpoint custom task", async () => {
  const root = await workspace();
  const mock = await startMockLearnHouse();
  try {
    await writeFile(join(root, "learning-context.json"), JSON.stringify(checkpoint()), "utf8");
    const service = new LearningContextService(configuration(root, mock.baseUrl));
    await assert.rejects(
      service.publishCheckpointDraft({
        confirm: true,
        assignmentUuid: "assignment_demo",
        assignmentTaskUuid: "reflection_task",
      }),
      /scope_mismatch/,
    );
    assert.equal(mock.calls.some((call) => call.method === "PUT"), false);
  } finally {
    await mock.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the service requires explicit confirmation before remote verification or a draft write", async () => {
  const root = await workspace();
  const mock = await startMockLearnHouse();
  try {
    const service = new LearningContextService(configuration(root, mock.baseUrl));
    await assert.rejects(
      service.publishCheckpointDraft({
        confirm: false,
        assignmentUuid: "assignment_demo",
        assignmentTaskUuid: "checkpoint_task",
      }),
      /confirmation_required/,
    );
    assert.equal(mock.calls.length, 0);
  } finally {
    await mock.close();
    await rm(root, { recursive: true, force: true });
  }
});
