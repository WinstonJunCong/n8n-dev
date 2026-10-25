// A8: undo / change guard (undo_change inside sealed editor, never external revert)
export const UNDO_ONLY = new Set([
  "undo_change",
  "pull_preview",
  "pull_apply",
  "submit_preview",
  "submit",
  "check_workflow",
  "draft_test_preview",
  "draft_test_save",
]);
export function canUndo(toolName) { return UNDO_ONLY.has(toolName); }
