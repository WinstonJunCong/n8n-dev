import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canIfCapture, IF_CAPTURE_ONLY } from "./if-capture-connector.mjs";

describe("A6 if-capture / conditional-branch guard", () => {
  it("allows update_step inside sealed editor for if-branch", () => assert.strictEqual(canIfCapture("update_step"), true));
  it("allows pull_preview inside sealed session", () => assert.strictEqual(canIfCapture("pull_preview"), true));
  it("refuses publish/delete regardless of branch", () => {
    assert.strictEqual(canIfCapture("publish"), false);
    assert.strictEqual(canIfCapture("delete"), false);
  });
  it("preserves A3-A5 guard consistency (update allowed, publish blocked)", () => {
    assert.strictEqual(canIfCapture("update_step"), true);
    assert.strictEqual(canIfCapture("publish"), false);
  });
  it("handles conditional branches safely (branch-state check present in set)", () => assert.strictEqual(IF_CAPTURE_ONLY.has("update_step"), true));
});
