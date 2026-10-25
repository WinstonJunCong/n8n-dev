// A9: full sealed-editor session guard (ui_start / ui_stop / ui_resume / ui_discard)
export const FULL_SESSION_ONLY = new Set([
  "ui_start", "ui_stop", "ui_resume", "ui_discard",
  "pull_preview", "pull_apply", "undo_change",
  "submit_preview", "submit",
  "check_workflow", "draft_test_preview", "draft_test_save",
  "update_step", "create_step",
]);
export function canFullSession(toolName) { return FULL_SESSION_ONLY.has(toolName); }
