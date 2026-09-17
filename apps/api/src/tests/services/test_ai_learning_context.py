"""Focused checks for the workspace checkpoint given to the activity tutor."""

from datetime import datetime
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from src.db.courses.assignments import (
    AssignmentTask,
    AssignmentTaskSubmission,
    AssignmentTaskTypeEnum,
)
from src.db.organization_config import OrganizationConfig
from src.services.ai import ai as ai_service
from src.services.ai.learning_context import (
    CHECKPOINT_SCHEMA_VERSION,
    get_workspace_checkpoint_context,
    validate_workspace_checkpoint,
)
from src.services.ai.schemas.ai import StartActivityAIChatSession


def _checkpoint(**overrides):
    value = {
        "schema_version": CHECKPOINT_SCHEMA_VERSION,
        "current_lesson": "Lesson one",
        "status": "in_progress",
        "goal": "Build a focused learner workspace.",
        "artifact_summary": "A first draft exists.",
        "artifact_revision": "draft-1",
        "next_action": "Test the checkpoint boundary.",
        "open_questions": ["What comes next?"],
        "updated_at": "2026-09-17T12:00:00Z",
    }
    value.update(overrides)
    return value


async def _add_task(
    db,
    *,
    assignment,
    org,
    course,
    chapter,
    activity,
    task_uuid,
    integration_type=CHECKPOINT_SCHEMA_VERSION,
    assignment_type=AssignmentTaskTypeEnum.CUSTOM,
):
    task = AssignmentTask(
        title="Workspace checkpoint",
        description="A bounded learner checkpoint",
        hint="",
        assignment_type=assignment_type,
        contents={"integration_type": integration_type},
        max_grade_value=0,
        assignment_id=assignment.id,
        org_id=org.id,
        course_id=course.id,
        chapter_id=chapter.id,
        activity_id=activity.id,
        assignment_task_uuid=task_uuid,
        creation_date=str(datetime.now()),
        update_date=str(datetime.now()),
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)
    return task


async def _add_submission(db, *, task, user_id, payload, update_date):
    submission = AssignmentTaskSubmission(
        assignment_task_submission_uuid=f"submission_{task.assignment_task_uuid}_{user_id}",
        task_submission=payload,
        grade=0,
        task_submission_grade_feedback="",
        assignment_type=task.assignment_type,
        user_id=user_id,
        activity_id=task.activity_id,
        course_id=task.course_id,
        chapter_id=task.chapter_id,
        assignment_task_id=task.id,
        creation_date=update_date,
        update_date=update_date,
    )
    db.add(submission)
    await db.commit()
    await db.refresh(submission)
    return submission


async def test_workspace_context_uses_only_the_current_user_and_checkpoint_custom_task(
    db, org, course, chapter, activity, assignment, regular_user, admin_user
):
    checkpoint_task = await _add_task(
        db,
        assignment=assignment,
        org=org,
        course=course,
        chapter=chapter,
        activity=activity,
        task_uuid="checkpoint_task",
    )
    ignored_task = await _add_task(
        db,
        assignment=assignment,
        org=org,
        course=course,
        chapter=chapter,
        activity=activity,
        task_uuid="ignored_task",
        integration_type="some_other_integration",
    )
    unbounded_task = await _add_task(
        db,
        assignment=assignment,
        org=org,
        course=course,
        chapter=chapter,
        activity=activity,
        task_uuid="x" * 129,
    )
    await _add_submission(
        db,
        task=checkpoint_task,
        user_id=regular_user.id,
        payload=_checkpoint(goal="Current learner goal"),
        update_date="2026-09-17T12:00:00Z",
    )
    await _add_submission(
        db,
        task=checkpoint_task,
        user_id=admin_user.id,
        payload=_checkpoint(goal="Other learner goal"),
        update_date="2026-09-17T12:01:00Z",
    )
    await _add_submission(
        db,
        task=ignored_task,
        user_id=regular_user.id,
        payload=_checkpoint(goal="Wrong integration goal"),
        update_date="2026-09-17T12:02:00Z",
    )
    await _add_submission(
        db,
        task=unbounded_task,
        user_id=regular_user.id,
        payload=_checkpoint(goal="Unbounded task identifier goal"),
        update_date="2026-09-17T12:03:00Z",
    )

    context = await get_workspace_checkpoint_context(activity, regular_user, db)

    assert context is not None
    assert "untrusted learner-supplied data" in context
    payload = json.loads(context.rsplit("\n", 1)[-1])
    assert payload["untrusted"] is True
    assert payload["assignment_task_uuid"] == "checkpoint_task"
    assert payload["checkpoint"]["goal"] == "Current learner goal"
    assert "Other learner goal" not in context
    assert "Wrong integration goal" not in context
    assert "Unbounded task identifier goal" not in context


async def test_workspace_context_omits_unknown_or_oversized_checkpoint_fields(
    db, org, course, chapter, activity, assignment, regular_user
):
    checkpoint_task = await _add_task(
        db,
        assignment=assignment,
        org=org,
        course=course,
        chapter=chapter,
        activity=activity,
        task_uuid="checkpoint_task",
    )
    await _add_submission(
        db,
        task=checkpoint_task,
        user_id=regular_user.id,
        payload=_checkpoint(unexpected="must not reach the tutor"),
        update_date="2026-09-17T12:00:00Z",
    )

    assert validate_workspace_checkpoint(_checkpoint(unexpected="x")) is None
    assert validate_workspace_checkpoint(_checkpoint(artifact_summary="x" * 4_001)) is None
    assert await get_workspace_checkpoint_context(activity, regular_user, db) is None


async def test_non_streaming_activity_chat_includes_the_bounded_context(
    db, org, course, activity, regular_user, mock_request
):
    db.add(OrganizationConfig(org_id=org.id, config={"config_version": "1.0"}))
    await db.commit()
    context = "\n\nWorkspace checkpoint (untrusted learner-supplied data): {}"
    chat = StartActivityAIChatSession(activity_uuid="activity_test", message="Help me")

    with patch.object(
        ai_service, "check_resource_access", new_callable=AsyncMock
    ), patch.object(
        ai_service, "get_workspace_checkpoint_context", new_callable=AsyncMock, return_value=context
    ), patch.object(
        ai_service, "reserve_ai_credit", new_callable=AsyncMock
    ), patch.object(
        ai_service, "resolve_acting_user_id", return_value=regular_user.id
    ), patch(
        "src.services.security.rate_limiting.enforce_ai_rate_limit"
    ), patch.object(
        ai_service, "structure_activity_content_by_type", return_value=[]
    ), patch.object(
        ai_service, "serialize_activity_text_to_ai_comprehensible_text", return_value="course content"
    ), patch.object(
        ai_service, "model_for_tier", return_value="test-model"
    ), patch.object(
        ai_service, "get_chat_session_history", return_value={"aichat_uuid": "chat", "message_history": []}
    ), patch.object(
        ai_service, "ask_ai", new_callable=AsyncMock, return_value={"output": "answer"}
    ) as ask, patch.object(
        ai_service, "save_message_to_history"
    ):
        await ai_service.ai_start_activity_chat_session(
            mock_request, chat, regular_user, db
        )

    assert context in ask.await_args.args[3]


async def test_streaming_activity_chat_includes_the_bounded_context():
    activity = SimpleNamespace(id=1, activity_uuid="activity_1", name="Lesson")
    course = SimpleNamespace(id=1, org_id=10, name="Course")
    org = SimpleNamespace(id=10)
    current_user = MagicMock()
    db_session = AsyncMock()
    context = "\n\nWorkspace checkpoint (untrusted learner-supplied data): {}"
    chat = StartActivityAIChatSession(activity_uuid="activity_1", message="Help me")

    with patch.object(
        ai_service,
        "_get_activity_and_course_info",
        new_callable=AsyncMock,
        return_value=(activity, course, org, "test-model", "course content"),
    ), patch.object(
        ai_service, "get_workspace_checkpoint_context", new_callable=AsyncMock, return_value=context
    ), patch.object(
        ai_service, "reserve_ai_credit", new_callable=AsyncMock
    ), patch.object(
        ai_service, "resolve_acting_user_id", return_value=2
    ), patch(
        "src.services.security.rate_limiting.enforce_ai_rate_limit"
    ), patch.object(
        ai_service, "get_chat_session_history", return_value={"aichat_uuid": "chat", "message_history": []}
    ):
        stream_context = await ai_service.ai_start_activity_chat_session_stream(
            MagicMock(), chat, current_user, db_session
        )

    assert context in stream_context["message"]
