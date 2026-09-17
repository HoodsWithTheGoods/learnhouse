import path from "node:path";

import { LearningContextMcpError } from "./types.js";

export const ENV = {
  baseUrl: "LEARNING_CONTEXT_MCP_BASE_URL",
  apiToken: "LEARNING_CONTEXT_MCP_API_TOKEN",
  orgSlug: "LEARNING_CONTEXT_MCP_ORG_SLUG",
  userId: "LEARNING_CONTEXT_MCP_USER_ID",
  courseUuid: "LEARNING_CONTEXT_MCP_COURSE_UUID",
  workspaceRoot: "LEARNING_CONTEXT_MCP_WORKSPACE_ROOT",
  checkpointPath: "LEARNING_CONTEXT_MCP_CHECKPOINT_PATH",
} as const;

export type RuntimeConfiguration = {
  baseUrl: string | null;
  apiToken: string | null;
  orgSlug: string | null;
  userId: number | null;
  courseUuid: string | null;
  workspaceRoot: string | null;
  checkpointPath: string | null;
  missing: string[];
};

export type ConfiguredRuntimeConfiguration = RuntimeConfiguration & {
  baseUrl: string;
  apiToken: string;
  orgSlug: string;
  userId: number;
  courseUuid: string;
  workspaceRoot: string;
  checkpointPath: string;
};

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const ORG_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

function configured(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function validBaseUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) return null;
    if (parsed.protocol === "https:") return parsed.toString().replace(/\/+$/, "");
    if (
      parsed.protocol === "http:" &&
      (parsed.hostname === "localhost" ||
        parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "[::1]")
    ) {
      return parsed.toString().replace(/\/+$/, "");
    }
  } catch {
    return null;
  }
  return null;
}

function validUserId(value: string | null): number | null {
  if (!value || !/^[1-9][0-9]{0,14}$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Load only the identity and location pins. This function does not open a
 * network connection or read a workspace file.
 */
export function loadRuntimeConfiguration(
  environment: Record<string, string | undefined> = process.env,
): RuntimeConfiguration {
  const rawBaseUrl = configured(environment[ENV.baseUrl]);
  const baseUrl = validBaseUrl(rawBaseUrl);
  const apiToken = configured(environment[ENV.apiToken]);
  const orgSlug = configured(environment[ENV.orgSlug]);
  const rawUserId = configured(environment[ENV.userId]);
  const userId = validUserId(rawUserId);
  const courseUuid = configured(environment[ENV.courseUuid]);
  const workspaceRoot = configured(environment[ENV.workspaceRoot]);
  const checkpointPath = configured(environment[ENV.checkpointPath]);
  const missing: string[] = [];

  if (!baseUrl) missing.push(ENV.baseUrl);
  if (!apiToken) missing.push(ENV.apiToken);
  if (!orgSlug || !ORG_SLUG.test(orgSlug)) missing.push(ENV.orgSlug);
  if (userId === null) missing.push(ENV.userId);
  if (!courseUuid || !IDENTIFIER.test(courseUuid)) missing.push(ENV.courseUuid);
  if (!workspaceRoot || !path.isAbsolute(workspaceRoot)) missing.push(ENV.workspaceRoot);
  if (!checkpointPath) missing.push(ENV.checkpointPath);

  return {
    baseUrl,
    apiToken,
    orgSlug,
    userId,
    courseUuid,
    workspaceRoot,
    checkpointPath,
    missing,
  };
}

export function requireConfigured(
  configuration: RuntimeConfiguration,
): asserts configuration is ConfiguredRuntimeConfiguration {
  if (configuration.missing.length > 0) {
    throw new LearningContextMcpError("configuration_missing");
  }
}

export function validIdentifier(value: string): boolean {
  return IDENTIFIER.test(value);
}
