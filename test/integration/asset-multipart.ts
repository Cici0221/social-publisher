import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import * as OTPAuth from "otpauth";
import sharp from "sharp";
import { db } from "../../src/server/db";
import { createMember } from "../../src/server/team";

const baseUrl = new URL(process.env.TEST_BASE_URL ?? "http://127.0.0.1:3000");
const origin = new URL(process.env.APP_URL ?? "http://localhost:3000").origin;
if (!["127.0.0.1", "localhost", "[::1]"].includes(baseUrl.hostname) || process.env.APP_MODE !== "local") {
  throw new Error("素材集成测试需要本机测试环境。");
}
const client = db();
const admin = await client.user.findFirstOrThrow({ where: { role: "ADMIN", active: true }, select: { id: true } });
const fixtureIds: string[] = [];
let fixtureContent: string | undefined;
let fixtureAsset: string | undefined;
let fixtureFolder: string | undefined;
let editorCookie: string | undefined;

async function request(path: string, cookie?: string, method = "GET", body?: object) {
  const headers = new Headers({ origin });
  if (cookie) headers.set("Cookie", cookie);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return fetch(new URL(path, baseUrl), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function signIn(role: "EDITOR" | "REVIEWER") {
  const email = `asset-qa-${randomUUID().slice(0, 8)}@example.test`;
  const password = "asset multipart test only";
  const { id, secret } = await createMember(admin.id, { email, password, name: "素材测试", role });
  fixtureIds.push(id);
  const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  const response = await request("/api/auth/login", undefined, "POST", { email, password, code });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  return { id, cookie };
}

try {
  assert.equal((await request("/api/assets")).status, 401);
  const editor = await signIn("EDITOR");
  editorCookie = editor.cookie;
  const reviewer = await signIn("REVIEWER");
  const width = 2700, height = 2200;
  const raw = randomBytes(width * height * 3);
  const media = await sharp(raw, { raw: { width, height, channels: 3 } })
    .png({ compressionLevel: 0 }).toBuffer();
  const payload = { filename: "素材集成测试-" + randomUUID().slice(0, 8) + ".png", mime: "image/png", bytes: media.length };
  assert.equal((await request("/api/assets/uploads", reviewer.cookie, "POST", payload)).status, 403);

  const original = await request("/api/assets/uploads", editor.cookie, "POST", payload);
  assert.equal(original.status, 200);
  const session = await original.json() as { id: string; partBytes: number };
  const sessionPath = "/api/assets/uploads/" + session.id;
  assert.ok(media.length > session.partBytes && media.length < 2 * session.partBytes);
  assert.equal((await request(sessionPath, reviewer.cookie)).status, 404);
  assert.equal((await request(sessionPath, editor.cookie, "POST")).status, 409);
  assert.equal((await request(sessionPath + "/part", editor.cookie, "POST", { part: 3 })).status, 422);

  async function upload(part: number, bytes: Buffer, expectOk = true) {
    const signed = await request(sessionPath + "/part", editor.cookie, "POST", { part });
    assert.equal(signed.status, 200);
    const { url, length } = await signed.json() as { url: string; length: number };
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname));
    if (expectOk) assert.equal(length, bytes.length);
    const response = await fetch(url, { method: "PUT", body: new Uint8Array(bytes) });
    // Some S3 emulators do not enforce signed Content-Length. The application
    // must still exclude the returned part by size before resuming/completing.
    if (!expectOk && response.ok && process.env.S3_TEST_EMULATOR === "moto") {
      const current = await request(sessionPath, editor.cookie);
      assert.equal(current.status, 200);
      assert.deepEqual((await current.json()).uploadedParts, []);
    } else {
      assert.equal(response.ok, expectOk);
    }
  }

  await upload(1, media.subarray(0, 18), false);
  await upload(1, media.subarray(0, session.partBytes));
  const resumed = await request("/api/assets/uploads", editor.cookie, "POST", { ...payload, resumeId: session.id });
  assert.equal(resumed.status, 200);
  assert.deepEqual((await resumed.json()).uploadedParts, [1]);
  assert.equal((await request(sessionPath, editor.cookie, "POST")).status, 409);
  await upload(2, media.subarray(session.partBytes));
  const completion = await request(sessionPath, editor.cookie, "POST");
  assert.equal(completion.status, 202);
  const asset = await completion.json() as { id: string };
  fixtureAsset = asset.id;
  const second = await request(sessionPath, editor.cookie, "POST");
  assert.equal(second.status, 202);
  assert.equal((await second.json()).id, asset.id);

  let ready: { width: number; height: number; bytes: number } | undefined;
  for (let elapsed = 0; elapsed < 45_000; elapsed += 450) {
    const result = await request("/api/assets?status=READY&q=" + encodeURIComponent(payload.filename), editor.cookie);
    assert.equal(result.status, 200);
    ready = (await result.json()).assets.find((row: { id: string }) => row.id === asset.id);
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 450));
  }
  assert.ok(ready, "metadata process did not finish");
  assert.equal(ready.width, width);
  assert.equal(ready.height, height);
  assert.equal(ready.bytes, media.length);
  const assetPath = "/api/assets/" + asset.id;
  const thumbnail = await request(assetPath + "/thumbnail", reviewer.cookie);
  assert.equal(thumbnail.status, 200);
  assert.equal((await sharp(Buffer.from(await thumbnail.arrayBuffer())).metadata()).format, "jpeg");
  const limited = await fetch(new URL(assetPath + "/file", baseUrl), {
    headers: { cookie: editor.cookie, range: "bytes=0-7" },
  });
  assert.equal(limited.status, 206);
  assert.deepEqual(Buffer.from(await limited.arrayBuffer()), media.subarray(0, 8));

  const folder = await request("/api/assets/folders", editor.cookie, "POST", { name: "素材验收 " + randomUUID() });
  fixtureFolder = (await folder.json()).id as string;
  const organized = await request(assetPath, editor.cookie, "PATCH", { folderId: fixtureFolder, tags: ["开幕式"] });
  assert.equal(organized.status, 200);
  const matching = await request(`/api/assets?folder=${fixtureFolder}&tag=${encodeURIComponent("开幕式")}`, editor.cookie);
  assert.equal((await matching.json()).assets[0].id, asset.id);

  const content = await client.content.create({ data: { ownerId: editor.id, versions: { ZH: { title: "开幕式预告" } },
    selections: [], overrides: {}, assets: { create: { assetId: asset.id } } } });
  fixtureContent = content.id;
  const refs = await request(assetPath, editor.cookie);
  assert.equal((await refs.json()).references[0].title, "开幕式预告");
  assert.equal((await request(assetPath, reviewer.cookie, "DELETE")).status, 403);
  const protectedDelete = await request(assetPath, editor.cookie, "DELETE");
  assert.equal(protectedDelete.status, 409);
  assert.equal((await protectedDelete.json()).references[0].id, content.id);
  await client.content.delete({ where: { id: content.id } });
  fixtureContent = undefined;
  assert.equal((await request(assetPath, editor.cookie, "DELETE")).status, 200);
  fixtureAsset = undefined;
  assert.equal((await request(assetPath + "/file", editor.cookie)).status, 404);
  console.info("通过：S3 实际分片校验、断点续传、媒体元数据、分页筛选、范围读取、角色隔离和素材引用保护。");
} finally {
  if (fixtureContent) await client.content.deleteMany({ where: { id: fixtureContent } });
  if (fixtureAsset && editorCookie) await request("/api/assets/" + fixtureAsset, editorCookie, "DELETE").catch(() => undefined);
  if (fixtureFolder) await client.assetFolder.deleteMany({ where: { id: fixtureFolder } });
  await client.user.updateMany({ where: { id: { in: fixtureIds } }, data: { active: false } });
  await client.$disconnect();
}
