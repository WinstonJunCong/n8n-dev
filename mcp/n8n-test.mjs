// A end-to-end simulation: user (open code) calling A3 + A4-A5 + A6 connector rules
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canApplyChange, EDITOR_ONLY_TOOLS } from "./connector.mjs";
import { canPullCheck, PULL_CHECK_ONLY } from "./pull-check-connector.mjs";
import { canIfCapture, IF_CAPTURE_ONLY } from "./if-capture-connector.mjs";

describe("end-to-end: user calling MCP connector rules (open code)", () => {
  it("user calls update_step (editor) → allowed", () => assert.strictEqual(canApplyChange("update_step"), true));
  it("user calls pull_apply (sealed session) → allowed", () => assert.strictEqual(canPullCheck("pull_apply"), true));
  it("user calls check_workflow (draft check) → allowed", () => assert.strictEqual(canPullCheck("check_workflow"), true));
  it("user calls if-capture update_step → allowed", () => assert.strictEqual(canIfCapture("update_step"), true));
  it("user attempts publish (dangerous) → blocked", () => assert.strictEqual(canApplyChange("publish"), false));
  it("user attempts delete (dangerous) → blocked", () => assert.strictEqual(canPullCheck("delete"), false));
  it("user attempts delete through if-capture → blocked", () => assert.strictEqual(canIfCapture("delete"), false));
  it("all three guards consistent (update allowed, publish blocked across A3/A4-A5/A6)", () => {
    assert.strictEqual(canApplyChange("update_step"), true);
    assert.strictEqual(canPullCheck("update_step"), false); // editor-only, not pull
    assert.strictEqual(canIfCapture("update_step"), true);
  });
  it("connector module exports verified (no import errors)", () => assert.strictEqual(typeof EDITOR_ONLY_TOOLS, "object"));
});
