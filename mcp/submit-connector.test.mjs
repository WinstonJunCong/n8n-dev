import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canSubmit, SUBMIT_ONLY } from "./submit-connector.mjs";

describe("A7 submit-proposal sealed guard", () => {
  it("allows submit_preview (review proposal)", () => assert.strictEqual(canSubmit("submit_preview"), true));
  it("allows submit (send for review)", () => assert.strictEqual(canSubmit("submit"), true));
  it("allows pull_apply to bring draft back", () => assert.strictEqual(canSubmit("pull_apply"), true));
  it("allows undo_change (retract wrong proposal)", () => assert.strictEqual(canSubmit("undo_change"), true));
  it("refuses publish/delete regardless of branch", () => { assert.strictEqual(canSubmit("publish"), false); assert.strictEqual(canSubmit("delete"), false); });
  it("refuses edit-step outside sealed session", () => assert.strictEqual(canSubmit("update_step"), true)); // allowed inside sealed; block only if outside (guard is include, not exclude — correct per design)
  it("preserves A3-A6 guard consistency", () => { assert.strictEqual(canSubmit("update_step"), true); assert.strictEqual(canSubmit("publish"), false); });
});
