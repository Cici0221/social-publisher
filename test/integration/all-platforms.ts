import "dotenv/config";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { TextWriter, Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from "@zip.js/zip.js";
import * as OTPAuth from "otpauth";
import sharp from "sharp";
import { emptyDraft } from "../../src/lib/draft-schema";
import { platformKeys, platformRules, type PlatformKey } from "../../src/lib/platforms";
import type { Actor } from "../../src/server/auth";
import { db } from "../../src/server/db";
import { publicationPlan } from "../../src/server/publications";
import { createMember } from "../../src/server/team";
import type { PlatformOptions } from "../../src/platforms/types";

const loopback = ["localhost", "127.0.0.1", "[::1]"];
const base = new URL(process.env.TEST_BASE_URL ?? "http://127.0.0.1:3000");
const origin = new URL(process.env.APP_URL ?? "http://localhost:3000");
const database = new URL(process.env.DATABASE_URL ?? "postgresql://unconfigured");
if (process.env.APP_MODE !== "local" || !loopback.includes(base.hostname) || !loopback.includes(origin.hostname) ||
    !loopback.includes(database.hostname) || process.env.MOCK_FAIL_PLATFORM) {
  throw new Error("此测试只允许本机模拟环境，且需清空 MOCK_FAIL_PLATFORM。");
}

const fixture = randomUUID().slice(0, 12);
const client = db();
const accounts = new Map<PlatformKey, string>();
const users: string[] = [];
const uploads: string[] = [];
let editorCookie: string | undefined;
let contentId: string | undefined;

type Task = { id: string; mode: string; platform: string; status: string; postUrl: string | null; errorMessage: string | null };
type Asset = { id: string; width: number; height: number; duration: number | null; status: string };

function request(path: string, cookie?: string, method = "GET", body?: object) {
  const headers = new Headers({ origin: origin.origin });
  if (cookie) headers.set("Cookie", cookie);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return fetch(new URL(path, base), {
    method, headers, redirect: "error", signal: AbortSignal.timeout(30_000),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function expected(response: Response, status: number, context: string) {
  if (response.status !== status) assert.fail(`${context}: HTTP ${response.status}: ${(await response.text()).slice(0, 650)}`);
  return response;
}

async function payload<T>(response: Response, status: number, context: string): Promise<T> {
  return (await expected(response, status, context)).json() as Promise<T>;
}

async function signIn(root: string, role: "ADMIN" | "EDITOR") {
  const email = `all-platforms-${role.toLowerCase()}-${fixture}@example.test`;
  const password = "all platforms test only";
  const name = `联提验收 ${role}`;
  const { id, secret } = await createMember(root, { email, name, password, role });
  users.push(id);
  const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  const response = await expected(await request("/api/auth/login", undefined, "POST", { email, password, code }), 200, role);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  const actor: Actor = { id, email, name, role, active: true };
  return { actor, cookie };
}

async function upload(cookie: string, filename: string, mime: string, bytes: Buffer): Promise<Asset> {
  const { id, partBytes } = await payload<{ id: string; partBytes: number }>(
    await request("/api/assets/uploads", cookie, "POST", { filename, mime, bytes: bytes.length }), 200, "开启素材上传",
  );
  const path = `/api/assets/uploads/${id}`;
  for (let offset = 0, part = 1; offset < bytes.length; offset += partBytes, part++) {
    const piece = bytes.subarray(offset, Math.min(bytes.length, offset + partBytes));
    const signed = await payload<{ length: number; url: string }>(await request(path + "/part", cookie, "POST", { part }), 200, "素材分片签名");
    assert.ok(loopback.includes(new URL(signed.url).hostname), "验收不能上传到外部对象存储");
    assert.equal(signed.length, piece.length);
    const sent = await fetch(signed.url, { method: "PUT", body: new Uint8Array(piece), redirect: "error", signal: AbortSignal.timeout(25_000) });
    assert.ok(sent.ok, `本机 S3 上传分片失败: ${sent.status}`);
  }
  const asset = await payload<{ id: string }>(await request(path, cookie, "POST"), 202, "完成素材上传");
  uploads.push(asset.id);
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await payload<{ assets: Asset[] }>(
      await request(`/api/assets?q=${encodeURIComponent(filename)}`, cookie), 200, "查询素材状态",
    );
    const row = result.assets.find(item => item.id === asset.id);
    if (row?.status === "READY") return row;
    if (row?.status === "FAILED") assert.fail(`${filename} 解析失败`);
    await delay(450);
  }
  assert.fail(`${filename} 没有在时限内就绪`);
}

const options: Partial<Record<PlatformKey, PlatformOptions>> = {
  youtube: { privacy: "private" }, x: { consent: true }, tiktok: { privacy: "SELF_ONLY", consent: true },
  douyin: { consent: true }, bilibili: { categoryId: 21, copyright: "1" },
};
const sharedLinks = {
  xiaohongshu: `https://www.xiaohongshu.com/explore/mock-${fixture}`,
  wechat: `https://weixin.qq.com/sph/mock-${fixture}`,
};

try {
  const health = await payload<{ status: string }>(await request("/api/health"), 200, "工作台状态");
  assert.equal(health.status, "ok");
  const preference = await client.preference.findUniqueOrThrow({ where: { id: "workspace" } });
  assert.equal(preference.reviewRequired, false, "联提验收要求测试环境审核保持默认关闭");
  const root = await client.user.findFirstOrThrow({ where: { role: "ADMIN", active: true }, select: { id: true } });
  const admin = await signIn(root.id, "ADMIN");
  const editor = await signIn(root.id, "EDITOR");
  editorCookie = editor.cookie;

  for (const platform of platformKeys) {
    const action = platformRules[platform].mode === "manual" ? "MANUAL" : "MOCK";
    const response = await request("/api/accounts", admin.cookie, "POST", { action, platform, name: `QA ${platform} ${fixture}`, language: "ZH" });
    const account = await payload<{ id: string; mode: string }>(response, 201, `登记 ${platform}`);
    assert.equal(account.mode, action);
    assert.ok(!("credential" in account));
    accounts.set(platform, account.id);
  }
  assert.equal(accounts.size, 14);

  const scratch = await mkdtemp(join(tmpdir(), "all-platforms-"));
  let videoBytes: Buffer;
  try {
    const file = join(scratch, "fixture.mp4");
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x274d49:s=576x1024:r=24:d=4",
      "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", file]);
    videoBytes = await readFile(file);
  } finally { await rm(scratch, { recursive: true, force: true }); }
  const coverBytes = await sharp({ create: { width: 576, height: 1024, channels: 3, background: "#274d49" } }).jpeg().toBuffer();
  const video = await upload(editor.cookie, `联提素材-${fixture}.mp4`, "video/mp4", videoBytes);
  assert.equal(video.width, 576);
  assert.equal(video.height, 1024);
  assert.ok(video.duration && video.duration >= 3);
  const cover = await upload(editor.cookie, `联提封面-${fixture}.jpg`, "image/jpeg", coverBytes);
  console.info("通过：实际对象存储上传、MP4 探测和 JPEG 封面。");

  const { id } = await payload<{ id: string }>(await request("/api/drafts", editor.cookie, "POST"), 201, "新建待发布草稿");
  contentId = id;
  const title = "十四平台演练";
  const draft = emptyDraft();
  draft.versions.ZH = { title, body: "这一段视频和图片由本机测试生成。", tags: ["联提测试"], assetIds: [video.id], coverId: cover.id };
  draft.selections = [...accounts].map(([platform, accountId]) => ({ accountId, options: options[platform] }));
  const { revision } = await payload<{ revision: number }>(await request("/api/drafts/" + id, editor.cookie, "PUT", { revision: 0, draft }), 200, "保存全平台草稿");

  const preview = await expected(await request(`/contents/${id}/publish`, editor.cookie), 200, "发布清单页面");
  const html = await preview.text();
  assert.match(html, /核对发布清单/);
  for (const key of platformKeys) assert.ok(html.includes(`QA ${key} ${fixture}`), `确认页缺少 ${key}`);
  const plan = await publicationPlan(editor.actor, id);
  assert.equal(plan.rows.length, 14);
  assert.deepEqual(plan.rows.filter(row => row.errors.length).map(({ platform, errors }) => ({ platform, errors })), []);
  assert.equal(plan.reviewRequired, false);

  const address = "/api/publications/" + id;
  await expected(await request(address, editor.cookie, "POST", { revision, skipInvalid: false }), 202, "一次提交全部目标");
  const duplicate = await request(address, editor.cookie, "POST", { revision, skipInvalid: false });
  assert.ok([404, 409].includes(duplicate.status), `未安全拒绝重复提交: ${duplicate.status}`);
  let tasks: Task[] = [];
  for (let attempt = 0; attempt < 120; attempt++) {
    tasks = (await payload<{ tasks: Task[] }>(await request(address, editor.cookie), 200, "查询发布进度")).tasks;
    if (tasks.length === 14 && tasks.every(task => ["SUCCESS", "MANUAL", "FAILED", "UNKNOWN"].includes(task.status))) break;
    await delay(350);
  }
  assert.equal(tasks.length, 14);
  assert.equal(tasks.filter(task => task.mode === "MOCK" && task.status === "SUCCESS" && !task.postUrl).length, 12,
    JSON.stringify(tasks.map(({ platform, status, errorMessage }) => ({ platform, status, errorMessage }))));
  const manual = tasks.filter(task => task.mode === "MANUAL" && task.status === "MANUAL");
  assert.deepEqual(new Set(manual.map(task => task.platform)), new Set(["xiaohongshu", "wechat"]));
  assert.equal(await client.publishTask.count({ where: { contentId: id } }), 14);
  console.info("通过：同一条视频一次校验并提交全部 14 平台，12 个模拟任务成功，2 个待人工发布。");

  for (const task of manual) {
    assert.ok(task.platform === "wechat" || task.platform === "xiaohongshu");
    const basePath = `/api/publications/tasks/${task.id}`;
    const delivery = await payload<{ accountName: string; backendUrl: string; copy: string; canConfirm: boolean }>(
      await request(basePath + "/manual", editor.cookie), 200, `读取 ${task.platform} 人工发布包`,
    );
    assert.equal(delivery.backendUrl, platformRules[task.platform].backend);
    assert.ok(delivery.copy.includes(title));
    assert.equal(delivery.canConfirm, true);
    const zipResponse = await expected(await request(basePath + "/package", editor.cookie), 200, "下载真实对象存储 ZIP");
    assert.match(zipResponse.headers.get("content-type") ?? "", /^application\/zip/);
    const zip = new ZipReader(new Uint8ArrayReader(new Uint8Array(await zipResponse.arrayBuffer())));
    try {
      const entries = (await zip.getEntries()).filter(entry => !entry.directory);
      assert.equal(entries.length, 3);
      const text = entries.find(entry => entry.filename === "发布文案.txt");
      const clip = entries.find(entry => entry.filename.endsWith(".mp4"));
      const image = entries.find(entry => entry.filename.endsWith(".jpg"));
      assert.ok(text && clip && image);
      assert.equal(await text.getData(new TextWriter()), delivery.copy);
      assert.deepEqual(Buffer.from(await clip.getData(new Uint8ArrayWriter())), videoBytes);
      assert.deepEqual(Buffer.from(await image.getData(new Uint8ArrayWriter())), coverBytes);
    } finally { await zip.close(); }

    const postUrl = sharedLinks[task.platform];
    const confirmed = await payload<{ postUrl: string; publishedAt: string }>(
      await request(basePath + "/manual", editor.cookie, "POST", { postUrl }), 200, `回填 ${task.platform} 测试链接`,
    );
    assert.equal(confirmed.postUrl, postUrl);
    assert.ok(confirmed.publishedAt);
  }
  const final = (await payload<{ tasks: Task[] }>(await request(address, editor.cookie), 200, "复查最终状态")).tasks;
  assert.equal(final.filter(task => task.status === "SUCCESS").length, 14);
  assert.equal(final.filter(task => task.status === "SUCCESS" && task.mode === "MANUAL" && task.postUrl).length, 2);
  assert.ok(final.every(task => task.mode !== "LIVE"));
  console.info("通过：两套官方后台跳转地址、流式 ZIP 三个条目逐字节验证、测试链接回填和全量记录。未向任一平台发帖。");
} finally {
  if (contentId) {
    await client.publishTask.deleteMany({ where: { contentId } });
    await client.content.deleteMany({ where: { id: contentId } });
  }
  if (editorCookie) {
    for (const assetId of uploads) await request(`/api/assets/${assetId}`, editorCookie, "DELETE").catch(() => undefined);
  }
  await client.platformAccount.deleteMany({ where: { id: { in: [...accounts.values()] } } });
  await client.notification.deleteMany({ where: { userId: { in: users } } });
  await client.user.updateMany({ where: { id: { in: users } }, data: { active: false } });
  await client.$disconnect();
}
