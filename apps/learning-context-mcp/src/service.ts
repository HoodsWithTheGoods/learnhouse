import {
  CHECKPOINT_SCHEMA_VERSION,
  readPinnedCheckpoint,
  type LearningCheckpoint,
} from "./checkpoint.js";
import { requireConfigured, validIdentifier, type RuntimeConfiguration } from "./config.js";
import { LearnHouseHttpClient } from "./client.js";
import { asRecord, LearningContextMcpError } from "./types.js";

const MAX_ASSIGNMENTS = 100;
const MAX_TASKS = 50;
const MAX_FEEDBACK_ITEMS = 50;

type CheckpointResult = {
  source: "workspace";
  untrusted: true;
  checkpoint: LearningCheckpoint;
};

function invalidRemote(): never {
  throw new LearningContextMcpError("remote_response_invalid");
}

function boundedString(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  return value.slice(0, limit);
}

function boundedInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function boundedNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function boundedArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) return invalidRemote();
  return value;
}

function checkpointResult(checkpoint: LearningCheckpoint): CheckpointResult {
  return { source: "workspace", untrusted: true, checkpoint };
}

function assignmentSummary(value: unknown): Record<string, unknown> {
  const assignment = asRecord(value);
  if (!assignment) return invalidRemote();
  const assignmentUuid = boundedString(assignment.assignment_uuid, 128);
  if (!assignmentUuid) return invalidRemote();
  return {
    assignment_uuid: assignmentUuid,
    title: boundedString(assignment.title, 300),
    description: boundedString(assignment.description, 2_000),
    due_date: boundedString(assignment.due_date, 80),
    published: typeof assignment.published === "boolean" ? assignment.published : null,
    activity_uuid: boundedString(assignment.activity_uuid, 128),
    ungraded: typeof assignment.ungraded === "boolean" ? assignment.ungraded : null,
  };
}

function taskSummary(value: unknown): Record<string, unknown> {
  const task = asRecord(value);
  if (!task) return invalidRemote();
  const taskUuid = boundedString(task.assignment_task_uuid, 128);
  if (!taskUuid) return invalidRemote();
  const contents = asRecord(task.contents);
  return {
    assignment_task_uuid: taskUuid,
    title: boundedString(task.title, 300),
    assignment_type: boundedString(task.assignment_type, 64),
    integration_type: boundedString(contents?.integration_type, 80),
  };
}

function assertAssignmentInPinnedCourse(
  value: unknown,
  configuration: RuntimeConfiguration,
  expectedAssignmentUuid: string,
): Record<string, unknown> {
  requireConfigured(configuration);
  const assignment = asRecord(value);
  if (!assignment) return invalidRemote();
  if (
    assignment.assignment_uuid !== expectedAssignmentUuid ||
    assignment.course_uuid !== configuration.courseUuid
  ) {
    throw new LearningContextMcpError("scope_mismatch");
  }
  return assignment;
}

function feedbackFromSubmission(
  value: unknown,
  userId: number,
): Record<string, unknown> | null {
  const submission = asRecord(value);
  if (!submission || submission.user_id !== userId) return null;
  const feedback = boundedString(submission.task_submission_grade_feedback, 2_000);
  if (!feedback) return null;
  return {
    grade: boundedInteger(submission.grade),
    feedback,
    updated_at: boundedString(submission.update_date, 80),
  };
}

/**
 * A small service layer that enforces the one learner and one course scope
 * before data crosses the MCP boundary.
 */
export class LearningContextService {
  private readonly client: LearnHouseHttpClient;

  public constructor(
    private readonly configuration: RuntimeConfiguration,
    client?: LearnHouseHttpClient,
  ) {
    this.client = client ?? new LearnHouseHttpClient(configuration);
  }

  public async getLearningState(): Promise<Record<string, unknown>> {
    requireConfigured(this.configuration);
    const [progress, assignments, checkpoint] = await Promise.all([
      this.client.getProgress(),
      this.client.getCourseAssignments(),
      readPinnedCheckpoint(this.configuration),
    ]);
    return {
      pinned_scope: {
        org_slug: this.configuration.orgSlug,
        user_id: this.configuration.userId,
        course_uuid: this.configuration.courseUuid,
      },
      progress: this.validateProgress(progress),
      assignments: this.validateAssignmentList(assignments),
      checkpoint: checkpointResult(checkpoint),
    };
  }

  public async getCourseAssignments(): Promise<Record<string, unknown>> {
    requireConfigured(this.configuration);
    const assignments = await this.client.getCourseAssignments();
    return {
      course_uuid: this.configuration.courseUuid,
      assignments: this.validateAssignmentList(assignments),
    };
  }

  public async getAssignmentFeedback(input: {
    assignmentUuid: string;
  }): Promise<Record<string, unknown>> {
    requireConfigured(this.configuration);
    const userId = this.configuration.userId;
    if (!validIdentifier(input.assignmentUuid)) invalidRemote();
    const assignment = assertAssignmentInPinnedCourse(
      await this.client.getAssignment(input.assignmentUuid),
      this.configuration,
      input.assignmentUuid,
    );
    const [tasksValue, assignmentSubmissionsValue] = await Promise.all([
      this.client.getAssignmentTasks(input.assignmentUuid),
      this.client.getAssignmentUserSubmissions(input.assignmentUuid),
    ]);
    const tasks = boundedArray(tasksValue);
    if (tasks.length > MAX_TASKS) return invalidRemote();
    const assignmentSubmissions = boundedArray(assignmentSubmissionsValue);
    if (assignmentSubmissions.length > MAX_FEEDBACK_ITEMS) return invalidRemote();

    const overallFeedback = assignmentSubmissions
      .filter((value) => asRecord(value)?.user_id === userId)
      .map((value) => asRecord(value)!)
      .map((submission) => ({
        grade: boundedInteger(submission.grade),
        feedback: boundedString(submission.overall_feedback, 2_000),
        updated_at: boundedString(submission.update_date, 80),
      }))
      .filter((submission) => submission.feedback !== null);

    const taskFeedback = await Promise.all(
      tasks.map(async (taskValue) => {
        const summary = taskSummary(taskValue);
        const taskUuid = summary.assignment_task_uuid as string;
        const submission = await this.client.getTaskUserSubmission(
          input.assignmentUuid,
          taskUuid,
        );
        const feedback = feedbackFromSubmission(submission, userId);
        return feedback ? { assignment_task_uuid: taskUuid, ...feedback } : null;
      }),
    );

    return {
      assignment: assignmentSummary(assignment),
      overall_feedback: overallFeedback,
      task_feedback: taskFeedback.filter((value) => value !== null),
    };
  }

  public async getLocalCheckpoint(): Promise<CheckpointResult> {
    requireConfigured(this.configuration);
    return checkpointResult(await readPinnedCheckpoint(this.configuration));
  }

  public async publishCheckpointDraft(input: {
    confirm: boolean;
    assignmentUuid: string;
    assignmentTaskUuid: string;
  }): Promise<Record<string, unknown>> {
    requireConfigured(this.configuration);
    if (input.confirm !== true) throw new LearningContextMcpError("confirmation_required");
    if (!validIdentifier(input.assignmentUuid) || !validIdentifier(input.assignmentTaskUuid)) {
      return invalidRemote();
    }
    const checkpoint = await readPinnedCheckpoint(this.configuration);

    const assignment = assertAssignmentInPinnedCourse(
      await this.client.getAssignment(input.assignmentUuid),
      this.configuration,
      input.assignmentUuid,
    );
    const tasks = boundedArray(await this.client.getAssignmentTasks(input.assignmentUuid));
    if (tasks.length > MAX_TASKS) return invalidRemote();
    const selectedTask = tasks
      .map((task) => asRecord(task))
      .find((task) => task?.assignment_task_uuid === input.assignmentTaskUuid);
    const contents = selectedTask ? asRecord(selectedTask.contents) : null;
    if (
      !selectedTask ||
      selectedTask.assignment_type !== "CUSTOM" ||
      contents?.integration_type !== CHECKPOINT_SCHEMA_VERSION
    ) {
      throw new LearningContextMcpError("scope_mismatch");
    }

    // This endpoint only persists task progress. It does not create an
    // assignment-level submission, grade work, or mark an activity complete.
    const receiptValue = await this.client.saveTaskSubmissionDraft(
      input.assignmentUuid,
      input.assignmentTaskUuid,
      checkpoint,
    );
    const receipt = asRecord(receiptValue);
    const submissionUuid = receipt
      ? boundedString(receipt.assignment_task_submission_uuid, 128)
      : null;
    if (!submissionUuid || !validIdentifier(submissionUuid)) return invalidRemote();
    return {
      assignment: assignmentSummary(assignment),
      assignment_task_uuid: input.assignmentTaskUuid,
      assignment_task_submission_uuid: submissionUuid,
      remote_draft_saved: true,
      local_checkpoint_edited: false,
      checkpoint: checkpointResult(checkpoint),
    };
  }

  private validateProgress(value: unknown): Record<string, unknown> {
    requireConfigured(this.configuration);
    const progress = asRecord(value);
    if (
      !progress ||
      progress.course_uuid !== this.configuration.courseUuid ||
      progress.user_id !== this.configuration.userId
    ) {
      throw new LearningContextMcpError("scope_mismatch");
    }
    const activityIds = boundedArray(progress.completed_activity_ids);
    if (activityIds.length > 1_000) return invalidRemote();
    return {
      course_uuid: this.configuration.courseUuid,
      user_id: this.configuration.userId,
      total_activities: boundedInteger(progress.total_activities),
      completed_activities: boundedInteger(progress.completed_activities),
      completion_percentage: boundedNumber(progress.completion_percentage),
      completed_activity_ids: activityIds
        .map((value) => boundedInteger(value))
        .filter((value): value is number => value !== null),
    };
  }

  private validateAssignmentList(value: unknown): Record<string, unknown>[] {
    const assignments = boundedArray(value);
    if (assignments.length > MAX_ASSIGNMENTS) return invalidRemote();
    return assignments.map((assignment) => assignmentSummary(assignment));
  }
}
