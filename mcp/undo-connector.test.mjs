import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canUndo, UNDO_ONLY } from "./undo-connector.mjs";

describe("A8 undo-change guard", () => {
  it("allows undo_change inside sealed session", () => assert.strictEqual(canUndo("undo_change"), true));
  it("allows pull_apply (revert by re-pulling previous)", () => assert.strictEqual(canUndo("pull_apply"), true));
  it("refuses publish/delete (revert must use sealed undo)", () => {
    assert.strictEqual(canUndo("publish"), false);
    assert.strictEqual(canUndo("delete"), false);
  });
  it("preserves A3-A7 guard consistency (undo allowed, publish blocked)", () => {
    assert.strictEqual(canUndo("undo_change"), true);
    assert.strictEqual(canUndo("publish"), false);
  });
});
