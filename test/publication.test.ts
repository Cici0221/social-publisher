import assert from "node:assert/strict";
import test from "node:test";
import { formatBody, measureCopy } from "../src/lib/platforms";
import { validatePublication } from "../src/lib/publication";
import { officialPublicationEvidenceLink, officialPublicationLink } from "../src/platforms/post-link";
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

test("Instagram preflight detects inherited video covers on image-only tasks", () => {
  const cover = { id: "cover", mime: "image/jpeg", kind: "IMAGE" as const, bytes: 100, width: 1080,
    height: 1080, duration: null, status: "READY" };
  const payload = { ...base, coverId: cover.id, assetIds: ["example"] };
  const checked = validatePublication("instagram", payload, [{ ...cover, id: "example" }], cover);
  assert.ok(checked.errors.some(error => error.includes("单个视频")));
});

test("manual reconciliation accepts an official post URL for the task platform", () => {
  const postLinks = {
    x: "https://x.com/brand/status/123",
    facebook: "https://www.facebook.com/permalink.php?story_fbid=123&id=456",
    linkedin: "https://www.linkedin.com/feed/update/urn%3Ali%3AugcPost%3A123/",
    youtube: "https://www.youtube.com/watch?v=video123",
  };
  for (const [platform, link] of Object.entries(postLinks)) assert.equal(officialPublicationLink(platform, link), link);
  assert.equal(officialPublicationLink("facebook", postLinks.x), null);
  assert.equal(officialPublicationLink("x", "http://x.com/brand/status/123"), null);
  assert.equal(officialPublicationLink("x", "https://x.com.example.test/brand/status/123"), null);
  assert.equal(officialPublicationLink("x", "https://user:password@x.com/brand/status/123"), null);
  assert.equal(officialPublicationLink("x", "https://x.com/brand"), null);
});

test("manual reconciliation supports official share and embed formats", () => {
  assert.equal(officialPublicationLink("facebook", "https://www.facebook.com/123_456"), "https://www.facebook.com/123_456");
  assert.equal(officialPublicationLink("youtube", "https://www.youtube-nocookie.com/embed/video123?autoplay=1"),
    "https://www.youtube.com/watch?v=video123");
  assert.equal(officialPublicationLink("linkedin", "https://www.linkedin.com/embed/feed/update/urn:li:share:123?collapsed=1"),
    "https://www.linkedin.com/feed/update/urn:li:share:123");
  const tiktok = "https://www.tiktok.com/player/v1/6718335390845095173";
  assert.equal(officialPublicationLink("tiktok", tiktok), tiktok);
  const douyin = "https://www.iesdouyin.com/share/video/6860305868517362957/?region=CN";
  assert.equal(officialPublicationLink("douyin", douyin), douyin);
  assert.equal(officialPublicationLink("facebook", "https://www.facebook.com/123"), null);
  assert.equal(officialPublicationLink("youtube", "https://www.youtube-nocookie.com/watch?v=video123"), null);
  assert.equal(officialPublicationLink("douyin", "https://www.iesdouyin.com/redirect/video/6860305868517362957/"), null);
});

test("unrecognized official URLs are retained as plain audit evidence without queries or fragments", () => {
  const raw = "https://x.com/new-post-format/123?token=secret#other-secret";
  assert.equal(officialPublicationLink("x", raw), null);
  assert.equal(officialPublicationEvidenceLink("x", raw), "https://x.com/new-post-format/123");
  assert.equal(officialPublicationEvidenceLink("x", raw.replace("x.com", "x.com.example.test")), null);
  assert.equal(officialPublicationEvidenceLink("x", raw.replace("https:", "http:")), null);
  assert.equal(officialPublicationEvidenceLink("x", raw.replace("x.com", "user@x.com")), null);
  assert.equal(officialPublicationEvidenceLink("x", "https://x.com/?next=unsafe"), null);
});
