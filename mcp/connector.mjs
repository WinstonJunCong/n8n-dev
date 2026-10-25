// Connector: only the editing tools reach the sealed editor.
export const EDITOR_ONLY_TOOLS = new Set([
  "search_step_types", "create_step", "update_step", "delete_step",
  "validate_step", "copy_step",
  "read_workflow", "describe_workflow", "update_workflow", "create_workflow",
  "validate_workflow", "run_check",
  "ui_start", "ui_stop", "ui_resume", "ui_discard",
]);
export function canApplyChange(toolName) {
  return EDITOR_ONLY_TOOLS.has(toolName);
}
