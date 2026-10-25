import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PULL_CHECK_ONLY } from "./pull-check-connector.mjs";

describe("A4-A5 sealed editor guard", () => {
  it("allows pull_preview", () => assert.strictEqual(PULL_CHECK_ONLY.has("pull_preview"), true));
  it("allows pull_apply", () => assert.strictEqual(PULL_CHECK_ONLY.has("pull_apply"), true));
  it("allows undo_change", () => assert.strictEqual(PULL_CHECK_ONLY.has("undo_change"), true));
  it("allows check_workflow", () => assert.strictEqual(PULL_CHECK_ONLY.has("check_workflow"), true));
  it("forbids edit_step outside editor (update_step blocked in pull path)", () => assert.strictEqual(PULL_CHECK_ONLY.has("update_step"), false));
  it("preserves previous EDITOR_ONLY rules from A3 (keep consistent)", () => {
    // sanity: create_step still forbidden outside editor path
    assert.strictEqual(PULL_CHECK_ONLY.has("create_step"), false);
  });
});
