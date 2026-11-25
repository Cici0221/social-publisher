import assert from "node:assert/strict";
import test from "node:test";
import { formatBody, measureCopy } from "../src/lib/platforms";
import { validatePublication } from "../src/lib/publication";
import type { PublishPayload } from "../src/platforms/types";

const base: PublishPayload = { title: "开幕通知", body: "请观看", tags: ["展会"], language: "ZH", assetIds: [], coverId: null, options: {} };
test("marks each platform independently and measures actual UTF-8 and weighted captions", () => {
  assert.equal(formatBody("bluesky", base), "开幕通知\n\n请观看\n\n#展会");
  assert.equal(formatBody("youtube", base), "请观看");
  assert.equal(measureCopy("youtube", "请"), 3);
  assert.equal(measureCopy("x", "中 https://example.com/long"), 26);
  assert.equal(validatePublication("bluesky", base, []).errors.length, 0);
  assert.ok(validatePublication("youtube", base, []).errors.some(message => message.includes("素材") || message.includes("视频")));
  assert.ok(validatePublication("youtube", base, []).errors.some(message => message.includes("公开范围")));
});
