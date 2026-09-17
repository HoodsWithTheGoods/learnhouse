import { requireConfigured, type RuntimeConfiguration } from "./config.js";
import { LearningContextMcpError } from "./types.js";

type FetchResponse = Pick<Response, "ok" | "json">;

export type FetchImplementation = (
  input: string,
  init: RequestInit,
) => Promise<FetchResponse>;

export const LEARNHOUSE_REQUEST_TIMEOUT_MS = 15_000;

/**
 * This client uses only pinned paths. It never accepts a URL, organization,
 * learner, or course from an MCP tool argument.
 */
export class LearnHouseHttpClient {
  private readonly fetchImplementation: FetchImplementation;

  public constructor(
    private readonly configuration: RuntimeConfiguration,
    private readonly options: {
      fetchImplementation?: FetchImplementation;
      timeoutMs?: number;
    } = {},
  ) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  public getProgress(): Promise<unknown> {
    requireConfigured(this.configuration);
    return this.request(
      `/api/v1/admin/${encodeURIComponent(this.configuration.orgSlug)}/progress/${this.configuration.userId}/${encodeURIComponent(this.configuration.courseUuid)}`,
    );
  }

  public getCourseAssignments(): Promise<unknown> {
    requireConfigured(this.configuration);
    return this.request(`/api/v1/assignments/course/${encodeURIComponent(this.configuration.courseUuid)}`);
  }

  public getAssignment(assignmentUuid: string): Promise<unknown> {
    return this.request(`/api/v1/assignments/${encodeURIComponent(assignmentUuid)}`);
  }

  public getAssignmentTasks(assignmentUuid: string): Promise<unknown> {
    return this.request(`/api/v1/assignments/${encodeURIComponent(assignmentUuid)}/tasks`);
  }

  public getAssignmentUserSubmissions(assignmentUuid: string): Promise<unknown> {
    requireConfigured(this.configuration);
    return this.request(
      `/api/v1/assignments/${encodeURIComponent(assignmentUuid)}/submissions/${this.configuration.userId}`,
    );
  }

  public getTaskUserSubmission(
    assignmentUuid: string,
    assignmentTaskUuid: string,
  ): Promise<unknown> {
    requireConfigured(this.configuration);
    return this.request(
      `/api/v1/assignments/${encodeURIComponent(assignmentUuid)}/tasks/${encodeURIComponent(assignmentTaskUuid)}/submissions/user/${this.configuration.userId}`,
    );
  }

  public saveTaskSubmissionDraft(
    assignmentUuid: string,
    assignmentTaskUuid: string,
    checkpoint: Record<string, unknown>,
  ): Promise<unknown> {
    requireConfigured(this.configuration);
    const query = new URLSearchParams({
      on_behalf_of_user_id: String(this.configuration.userId),
    });
    return this.request(
      `/api/v1/assignments/${encodeURIComponent(assignmentUuid)}/tasks/${encodeURIComponent(assignmentTaskUuid)}/submissions?${query.toString()}`,
      "PUT",
      { task_submission: checkpoint },
    );
  }

  private async request(path: string, method = "GET", body?: Record<string, unknown>): Promise<unknown> {
    requireConfigured(this.configuration);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs ?? LEARNHOUSE_REQUEST_TIMEOUT_MS,
    );
    try {
      const headers: Record<string, string> = {
        accept: "application/json",
        authorization: `Bearer ${this.configuration.apiToken}`,
      };
      if (body) headers["content-type"] = "application/json";
      const response = await this.fetchImplementation(`${this.configuration.baseUrl}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      if (!response.ok) throw new LearningContextMcpError("api_unavailable");
      try {
        return await response.json();
      } catch {
        throw new LearningContextMcpError("remote_response_invalid");
      }
    } catch (error) {
      if (error instanceof LearningContextMcpError) throw error;
      throw new LearningContextMcpError("api_unavailable");
    } finally {
      clearTimeout(timeout);
    }
  }
}
