# iLearning learning-context bridge

## Current outcome

Build a first private bridge for one learner, one LearnHouse course, and one local workspace.

The LearnHouse API owns course progress, assignments, submissions, and feedback.
The local workspace owns private memory, files, procedures, and skills.
The bridge reads both owners and exposes only a selected learning checkpoint.

## First release

- Add a standalone STDIO MCP server under `apps/learning-context-mcp/`.
- Pin one organization, learner, course, and workspace through environment variables.
- Expose read tools for the learning state, course assignments, feedback, and the local checkpoint.
- Expose one confirmed write tool that publishes the reviewed local checkpoint to a declared custom assignment task.
- Never submit, grade, delete, or complete an activity in this release.
- Add a small context reader for the LearnHouse activity tutor.
- Include only approved checkpoint fields in the tutor context.
- Treat all checkpoint values as untrusted learner data.
- Keep credentials outside Git and workspace files.

## Shared checkpoint

The checkpoint uses `learning-context.json` and these fields:

- `schema_version`
- `current_lesson`
- `status`
- `goal`
- `artifact_summary`
- `artifact_revision`
- `next_action`
- `open_questions`
- `updated_at`

The bridge does not read other workspace files.

## Acceptance

1. A real MCP client can list and call the bridge tools through STDIO.
2. A mock LearnHouse API check proves the exact request paths and bearer header.
3. The bridge rejects a checkpoint outside the pinned workspace.
4. The bridge rejects an unknown checkpoint field or an oversized value.
5. The draft write requires an explicit confirmation value.
6. The activity tutor receives only a validated checkpoint for the current learner and activity.
7. Focused tests pass without a LearnHouse account or a model call.

## Limits

The first release does not prove a live LearnHouse deployment, a real learner result, or an Adapa installation.
Those checks require a selected LearnHouse instance and account configuration.

## Build result — 2026-09-17

Status: local candidate complete.

- The fork is `HoodsWithTheGoods/learnhouse`.
- The working branch is `codex/learning-context-mcp`.
- The STDIO bridge exposes four read tools and one confirmed draft-write tool.
- The LearnHouse tutor reads only a marked custom-task checkpoint for the current learner and activity.
- Nine MCP tests pass.
- Four LearnHouse API tests pass in the repository Python 3.14.7 container.
- The personal-agent `0.2.0` package contains the matching checkpoint and a token-free Codex connection example.

The remaining next event is a private LearnHouse instance or Cloud organization with scoped API access.
No live connection, Adapa deployment, or learner trial has run.
