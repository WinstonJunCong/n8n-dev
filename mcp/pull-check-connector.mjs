// A4-A5 connector guard: pull / check workflow only inside sealed editor.
export const PULL_CHECK_ONLY = new Set([
  "pull_preview", "pull_apply", "undo_change",
  "check_workflow", "draft_test_preview", "draft_test_save",
  "list_workflows", "describe_workflow", "update_workflow",
  "validate_workflow", "create_workflow",
  "ui_start", "ui_stop", "ui_resume", "ui_discard",
]);
export function canPullCheck(toolName) { return PULL_CHECK_ONLY.has(toolName); }
