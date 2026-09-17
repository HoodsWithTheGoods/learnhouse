export type LearningContextMcpErrorCode =
  | "api_unavailable"
  | "checkpoint_path_invalid"
  | "configuration_missing"
  | "confirmation_required"
  | "invalid_checkpoint"
  | "remote_response_invalid"
  | "scope_mismatch";

export class LearningContextMcpError extends Error {
  public constructor(public readonly code: LearningContextMcpErrorCode) {
    super(code);
    this.name = "LearningContextMcpError";
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
