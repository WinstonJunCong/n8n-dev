// A7: sealed proposal submission guard (submit_preview / submit)
// Only reaches reviewer through sealed session; never touches live n8n or repo directly.
export const SUBMIT_ONLY = new Set([
  "submit_preview",
  "submit",
  "pull_preview",
  "pull_apply",
  "undo_change",
  "check_workflow",
  "draft_test_preview",
  "draft_test_save",
  "update_step",
  "create_step",
]);
export function canSubmit(toolName) { return SUBMIT_ONLY.has(toolName); }
