import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyDraft, updateDraftCopy, draftAssetReferences } from "../src/lib/draft-schema";
import { dateInPublishZone, localPublishTimeToDate, normalizePublishZone, publishTimeInput } from "../src/lib/publish-time";
import { calendarPeriod, calendarWhere, parseCalendarParams } from "../src/server/calendar";
import { AppError } from "../src/server/errors";
import { copyDraftWithAssets, csvCell, historyWhere, parseHistoryFilters, publisherScope, recordCopyLabel, verifiedPostUrl } from "../src/server/history";
import { inboxHref } from "../src/server/notification-read";

test("wall-clock conversion uses the selected platform scheduling time zone", () => {
  const parsed = "2026-11-25T00:30:15.126";
  const tokyo = localPublishTimeToDate(parsed, "Asia/Tokyo")!;
  assert.equal(tokyo.toISOString(), "2026-11-24T15:30:15.126Z");
  assert.equal(localPublishTimeToDate(parsed, "Asia/Shanghai")?.toISOString(), "2026-11-24T16:30:15.126Z");
  assert.equal(localPublishTimeToDate(parsed, "Asia/Ho_Chi_Minh")?.toISOString(), "2026-11-24T17:30:15.126Z");
  assert.equal(dateInPublishZone(tokyo, "Asia/Ho_Chi_Minh"), "2026-11-24");
  assert.equal(publishTimeInput(tokyo, "Asia/Tokyo"), "2026-11-25T00:30");
  assert.equal(localPublishTimeToDate("2026-02-29T12:00", "Asia/Shanghai"), null);
  assert.equal(localPublishTimeToDate("2026-12-22T24:00", "Asia/Shanghai"), null);
  assert.equal(normalizePublishZone("Asia/Phnom_Penh"), "Asia/Shanghai");
});

test("weekly and monthly calendars use half-open intervals and Monday grid boundaries", () => {
  const week = calendarPeriod("2026-11-25", "week", "Asia/Shanghai");
  assert.equal(week.first, "2026-11-23");
  assert.equal(week.last, "2026-11-29");
  assert.equal(week.previous, "2026-11-16");
  assert.equal(week.startInstant.toISOString(), "2026-11-22T16:00:00.000Z");
  assert.equal(week.nextInstant.toISOString(), "2026-11-29T16:00:00.000Z");
  assert.equal(week.days.length, 7);
  const month = calendarPeriod("2026-11-25", "month", "Asia/Tokyo");
  assert.equal(month.startInstant.toISOString(), "2026-10-31T15:00:00.000Z");
  assert.equal(month.nextInstant.toISOString(), "2026-11-30T15:00:00.000Z");
  assert.deepEqual(month.days[0], { date: "2026-10-26", inside: false });
  assert.deepEqual(month.days.at(-1), { date: "2026-12-06", inside: false });
  const range = { gte: month.startInstant, lt: month.nextInstant };
  assert.deepEqual(calendarWhere({ id: "editor-id", role: "EDITOR" }, month), { AND: [
    { publisherId: "editor-id" }, { OR: [
      { status: "SUCCESS", publishedAt: range },
      { status: { in: ["WAITING_APPROVAL", "SCHEDULED", "QUEUED", "UPLOADING", "PUBLISHING", "PROCESSING", "MANUAL"] }, runAt: range },
    ] },
  ] });
  assert.equal(parseCalendarParams(new URLSearchParams("zone=Asia%2FTokyo"), new Date("2026-11-24T15:00:00Z")).date, "2026-11-25");
});

test("history filters keep editor scope when publisher and date are requested", () => {
  const otherUser = "73ca9940-aff7-453a-acba-a4d4efadd727";
  const editor = { id: "9db43f24-1fbe-4c57-97d5-6259e199446f", role: "EDITOR" as const };
  const filters = parseHistoryFilters(new URLSearchParams({
    publisher: otherUser, from: "2026-11-25", through: "2026-11-25", zone: "Asia/Ho_Chi_Minh", status: "SUCCESS", platform: "bluesky",
  }));
  const clauses = historyWhere(editor, filters).AND;
  const range = { gte: new Date("2026-11-24T17:00:00.000Z"), lt: new Date("2026-11-25T17:00:00.000Z") };
  assert.deepEqual(clauses, [
    { publisherId: editor.id },
    { platform: "bluesky", status: "SUCCESS", publisherId: otherUser },
    { OR: [{ publishedAt: range }, { publishedAt: null, runAt: range }] },
  ]);
  assert.deepEqual(publisherScope({ id: "admin-id", role: "ADMIN" }), {});
  assert.throws(() => publisherScope({ id: "reviewer-id", role: "REVIEWER" }), (error: unknown) => error instanceof AppError && error.status === 403);
  assert.throws(() => parseHistoryFilters(new URLSearchParams("from=2026-11-26&through=2026-11-25")), AppError);
});

test("CSV cells protect against formulas and preserve Unicode and multiline content", () => {
  assert.equal(csvCell("一键发布"), '"一键发布"');
  assert.equal(csvCell('公告 "一键发布"\n下一行'), '"公告 ""一键发布""\n下一行"');
  for (const formula of ["=2+2", " \t=1", "\uFEFF\u200B＋1", "+100", "-100", "@sum(1)", "\rnext", "\t编辑"]) {
    assert.ok(csvCell(formula).startsWith("\"'"));
  }
  assert.equal(recordCopyLabel({ mode: "MOCK", status: "SUCCESS" }), "模拟文案");
  assert.equal(verifiedPostUrl("javascript:doSomething()"), null);
  assert.equal(verifiedPostUrl("https://publisher:password@example.com/post"), null);
});

test("duplicate draft carries authored variants and valid assets, but requires fresh account choices", () => {
  const video = "333b3849-6ea7-4561-8576-02683cbbf78b";
  const poster = "d2d3e7b2-af87-4719-94f3-277ef4f9dcd5";
  const removed = "ba80d177-a539-4e6f-a593-bdd01280fd8f";
  let original = updateDraftCopy(emptyDraft(), null, "ZH", { title: "标题", body: "正文", tags: ["原话题"], assetIds: [video, removed], coverId: poster });
  original = updateDraftCopy(original, "youtube", "ZH", { title: "YouTube 标题", coverId: video });
  original = updateDraftCopy(original, null, "JA", { title: "日本語", assetIds: [poster] });
  original.selections.push({
    accountId: "ab6ccdd2-62ae-4cac-a71b-2e75518269d7", runAt: "2026-11-25T10:30:00.000Z", options: { consent: true },
  });

  const copy = copyDraftWithAssets(original, [
    { id: video, kind: "VIDEO", status: "READY" },
    { id: poster, kind: "IMAGE", status: "READY" },
    { id: removed, kind: "IMAGE", status: "DELETED" },
  ]);
  assert.deepEqual(copy.selections, []);
  assert.equal(copy.versions.ZH.body, "正文");
  assert.deepEqual(copy.versions.ZH.assetIds, [video]);
  assert.equal(copy.versions.ZH.coverId, poster);
  assert.equal(copy.versions.JA?.title, "日本語");
  assert.equal(copy.overrides.youtube?.ZH?.title, "YouTube 标题");
  assert.equal(copy.overrides.youtube?.ZH?.coverId, null);
  assert.deepEqual(draftAssetReferences(copy).assetIds, [video, poster].sort());
});

test("notification destinations accept app routes and reject external navigation", () => {
  assert.equal(inboxHref("/contents/123/progress"), "/contents/123/progress");
  assert.equal(inboxHref("/calendar?view=day#result"), "/calendar?view=day#result");
  assert.equal(inboxHref("https://outside.example"), null);
  assert.equal(inboxHref("//outside.example"), null);
  assert.equal(inboxHref("/\\outside.example"), null);
  assert.equal(inboxHref("/\noutside.example"), null);
});
