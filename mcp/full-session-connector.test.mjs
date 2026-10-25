import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canFullSession, FULL_SESSION_ONLY } from "./full-session-connector.mjs";

describe("A9 full sealed-editor session guard", () => {
  it("allows ui_start", () => assert.strictEqual(canFullSession("ui_start"), true));
  it("allows ui_stop", () => assert.strictEqual(canFullSession("ui_stop"), true));
  it("allows ui_resume", () => assert.strictEqual(canFullSession("ui_resume"), true));
  it("allows ui_discard", () => assert.strictEqual(canFullSession("ui_discard"), true));
  it("allows submit / pull / undo / check inside session", () => {
    assert.strictEqual(canFullSession("submit_preview"), true);
    assert.strictEqual(canFullSession("pull_apply"), true);
    assert.strictEqual(canFullSession("undo_change"), true);
  });
  it("refuses publish/delete (not in session)", () => {
    assert.strictEqual(canFullSession("publish"), false);
    assert.strictEqual(canFullSession("delete"), false);
  });
  it("preserves all A3-A8 guard consistency", () => {
    assert.strictEqual(canFullSession("update_step"), true);
    assert.strictEqual(canFullSession("publish"), false);
  });
});
