# Learning context MCP

This local STDIO server connects one LearnHouse learner and course to one workspace checkpoint.

The server reads only the configured checkpoint file. It does not scan the workspace.

The server reads course progress, assignments, and feedback through the LearnHouse API.

`publish_checkpoint_draft` reads the reviewed local checkpoint and saves one remote task draft. It never edits local files, submits, grades, completes, or deletes work.

## Required environment variables

- `LEARNING_CONTEXT_MCP_BASE_URL` must be an HTTPS LearnHouse URL, or a loopback HTTP URL for a local test.
- `LEARNING_CONTEXT_MCP_API_TOKEN` must remain outside Git and workspace files.
- `LEARNING_CONTEXT_MCP_ORG_SLUG` pins one organization.
- `LEARNING_CONTEXT_MCP_USER_ID` pins one learner.
- `LEARNING_CONTEXT_MCP_COURSE_UUID` pins one course.
- `LEARNING_CONTEXT_MCP_WORKSPACE_ROOT` pins one local workspace directory.
- `LEARNING_CONTEXT_MCP_CHECKPOINT_PATH` pins one file below that directory.

Copy [examples/learning-context.json](examples/learning-context.json) to the configured checkpoint path.

Copy [examples/.codex/config.toml.example](examples/.codex/config.toml.example) to a workspace `.codex/config.toml` file. Set the token in the host environment.

## Checkpoint contract

The checkpoint must contain exactly these fields:

- `schema_version`, equal to `workspace_checkpoint_v1`
- `current_lesson`
- `status`
- `goal`
- `artifact_summary`
- `artifact_revision`
- `next_action`
- `open_questions`
- `updated_at`

The server rejects unknown fields, invalid timestamps, oversized values, files above 16 KiB, symlinks, and paths outside the pinned workspace.

All checkpoint values are learner supplied and untrusted. A tutor must treat them as context, never as instructions.

## Run checks

```sh
npm install
npm run typecheck
npm test
```
