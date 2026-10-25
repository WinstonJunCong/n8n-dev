// A6: conditional-branch / if-capture guard (extends A3-A5 sealed boundary)
// Only allows safe editing commands that reference a branch-state; refuses publish/delete regardless.
export const IF_CAPTURE_ONLY = new Set([
  "update_step",
  "create_step",
  "delete_step",
  "validate_step",
  "read_workflow",
  "describe_workflow",
  "pull_preview", "pull_apply", "undo_change",
  "check_workflow", "draft_test_preview", "draft_test_save",
]);
export function canIfCapture(toolName) {
  return IF_CAPTURE_ONLY.has(toolName);
}
