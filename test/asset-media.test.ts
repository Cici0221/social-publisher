import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { imageMetadata, videoMetadata } from "../src/server/assets/metadata";
import {
  assertCompleteParts, checkedUpload, expectedPartBytes, MAX_ASSET_BYTES, UPLOAD_PART_BYTES, verifiedParts,
} from "../src/server/assets/limits";

test("upload limits validate type, normalized name, and size through 2 GiB", () => {
  assert.deepEqual(checkedUpload(" 宣传素材.MOV ", "", MAX_ASSET_BYTES), {
    mime: "video/quicktime", kind: "VIDEO", filename: "宣传素材.MOV", extension: "mov", bytes: MAX_ASSET_BYTES,
  });
  assert.throws(() => checkedUpload("视频.mp4", "video/mp4", MAX_ASSET_BYTES + 1), /2 GiB/);
  assert.throws(() => checkedUpload("宣传图.jpg", "image/png", 1024), /格式/);
  assert.throws(() => checkedUpload("../宣传片.mp4", "video/mp4", 100), /文件名/);
  assert.throws(() => checkedUpload("mp4", "", 100), /请选择/);
});

test("multipart resumes only matching parts and refuses gaps, oversized tails, and duplicate numbers", () => {
  const bytes = UPLOAD_PART_BYTES * 2 + 19;
  const first = { PartNumber: 1, Size: UPLOAD_PART_BYTES, ETag: '"a"' };
  const second = { PartNumber: 2, Size: UPLOAD_PART_BYTES, ETag: '"b"' };
  const third = { PartNumber: 3, Size: 19, ETag: '"c"' };
  assert.equal(expectedPartBytes(bytes, 3), 19);
  assert.throws(() => expectedPartBytes(bytes, 4), /分片编号/);
  assert.deepEqual(verifiedParts(bytes, [third, first, { ...second, Size: 9 }]), [
    { PartNumber: 1, ETag: '"a"' }, { PartNumber: 3, ETag: '"c"' },
  ]);
  assert.throws(() => assertCompleteParts(bytes, [first, third]), /未完成/);
  assert.throws(() => assertCompleteParts(bytes, [first, second, { ...third, Size: 20 }]), /大小/);
  assert.throws(() => assertCompleteParts(bytes, [first, second, third, third]), /大小/);
  assert.deepEqual(assertCompleteParts(bytes, [third, first, second]).map(part => part.PartNumber), [1, 2, 3]);
  assert.equal(expectedPartBytes(MAX_ASSET_BYTES, 128), UPLOAD_PART_BYTES);
});

test("server decodes image contents and renders a bounded JPEG thumbnail", async () => {
  const png = await sharp({ create: { width: 1280, height: 720, channels: 3, background: "#497764" } }).png().toBuffer();
  const result = await imageMetadata(png, "image/png");
  assert.equal(result.width, 1280);
  assert.equal(result.height, 720);
  assert.equal(result.duration, null);
  const thumbnail = await sharp(result.thumbnail).metadata();
  assert.equal(thumbnail.format, "jpeg");
  assert.equal(thumbnail.width, 480);
  assert.equal(thumbnail.height, 270);
  await assert.rejects(imageMetadata(png, "image/jpeg"), /文件内容/);
  await assert.rejects(imageMetadata(Buffer.from("fake jpg"), "image/jpeg"), /文件内容/);
});

function hasFFmpeg() {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    return true;
  } catch { return false; }
}

test("server probes video orientation, duration and thumbnail without trusting MIME", { skip: !hasFFmpeg() }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "publisher-test-media-"));
  try {
    const video = join(directory, "clip.mp4");
    const thumbnail = join(directory, "clip.jpg");
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
      "color=size=320x180:rate=12:color=teal", "-t", "0.75", "-vcodec", "mpeg4", video]);
    const verified = await videoMetadata(video, "video/mp4", thumbnail);
    assert.equal(verified.width, 320);
    assert.equal(verified.height, 180);
    assert.ok(verified.duration && verified.duration > 0.5 && verified.duration < 1);
    assert.equal((await sharp(verified.thumbnail).metadata()).format, "jpeg");
    await assert.rejects(videoMetadata(video, "video/quicktime", thumbnail), /文件内容/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
