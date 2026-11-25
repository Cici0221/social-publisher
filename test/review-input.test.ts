import assert from "node:assert/strict";
import test from "node:test";
import { reviewDecisionSchema, reviewSettingsSchema } from "../src/server/reviews";

test("审核需要修订版本、明确决定和非空意见", () => {
  assert.deepEqual(reviewDecisionSchema.parse({ revision: 2, decision: "approve", note: "  内容已核对。  " }),
    { revision: 2, decision: "approve", note: "内容已核对。" });
  for (const input of [
    { revision: 2, decision: "return", note: " " },
    { revision: -1, decision: "approve", note: "ok" },
    { revision: 0, decision: "anything", note: "ok" },
    { revision: 2, decision: "return", note: "ok", actorId: "spoofed" },
  ]) assert.equal(reviewDecisionSchema.safeParse(input).success, false);
});

test("审核设置只接受布尔值作为开关", () => {
  assert.deepEqual(reviewSettingsSchema.parse({ required: false }), { required: false });
  assert.equal(reviewSettingsSchema.safeParse({ required: "false" }).success, false);
});
