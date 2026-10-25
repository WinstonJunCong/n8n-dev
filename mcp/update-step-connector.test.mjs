import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canApplyChange, EDITOR_ONLY_TOOLS } from "./connector.mjs";

describe("A3 connector edit path", () => {
  it("allows update_step (editor tool)", () => assert.strictEqual(canApplyChange("update_step"), true));
  it("refuses publish", () => assert.strictEqual(canApplyChange("publish"), false));
  it("refuses delete", () => assert.strictEqual(canApplyChange("delete"), false));
  it("has allowed editing tools", () => assert.strictEqual(EDITOR_ONLY_TOOLS.size, 16));
});
