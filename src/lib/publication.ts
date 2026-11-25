import { formatBody, measureCopy, platformRules, type PlatformKey } from "./platforms";
import type { PublishPayload } from "@/platforms/types";

export type MaterialInfo = {
  id: string;
  mime: string;
  kind: "IMAGE" | "VIDEO";
  bytes: bigint | number;
  width: number | null;
  height: number | null;
  duration: number | null;
  status: string;
};

export type Validation = { errors: string[]; warnings: string[] };

export function validatePublication(key: PlatformKey, payload: PublishPayload, files: MaterialInfo[], cover?: MaterialInfo): Validation {
  const rule = platformRules[key];
  const errors: string[] = [];
  const warnings: string[] = [];
  const images = files.filter(file => file.kind === "IMAGE");
  const videos = files.filter(file => file.kind === "VIDEO");

  if (!files.length && !rule.allowText) errors.push("请添加平台支持的图片或视频。");
  if (!files.length && !payload.body.trim()) errors.push("请填写正文或添加素材。");
  if (images.length && videos.length && !rule.allowMixed) errors.push("该平台不支持在同一条内容中混发图片和视频。");
  if (files.length > 1 && files.some(file => rule.exclusiveImageFormats?.includes(file.mime))) errors.push("动图需单独发布。");
  if (rule.maxMedia && files.length > rule.maxMedia) errors.push(`素材最多可选 ${rule.maxMedia} 个。`);
  if (files.length !== payload.assetIds.length || files.some(file => file.status !== "READY")) errors.push("有素材不可用。");
  if (rule.requiredTitle && !payload.title.trim()) errors.push("请填写标题。");
  if (rule.requiredTags && !payload.tags.length) errors.push("请填写话题标签。");

  for (const field of ["title", "body"] as const) {
    const limit = rule[field];
    if (!limit) continue;
    const length = measureCopy(key, payload[field], field);
    if (length > limit.max) errors.push(`${field === "title" ? "标题" : "正文"}超出 ${length - limit.max}，上限 ${limit.max}。`);
  }

  if (rule.maxTags && payload.tags.length > rule.maxTags) errors.push(`最多可填写 ${rule.maxTags} 个话题标签。`);
  if (rule.tagsLimit && measureCopy(key, payload.tags.join(",")) > rule.tagsLimit.max) {
    errors.push(`话题标签合计最多 ${rule.tagsLimit.max} 个字符。`);
  }

  for (const [kind, type, collection] of [["image", "图片", images], ["video", "视频", videos]] as const) {
    const spec = rule[kind];
    if (!spec && collection.length) {
      errors.push(`该平台不接受${type}。`);
      continue;
    }
    if (!spec) continue;
    if (collection.length > spec.maxCount) errors.push(`${type}最多可选 ${spec.maxCount} 个。`);
    for (const file of collection) {
      const limit = spec.formatBytes?.[file.mime] ?? spec.maxBytes;
      if (!spec.formats.includes(file.mime)) errors.push(`${type}格式 ${file.mime} 不受支持。`);
      if (limit && Number(file.bytes) > limit) errors.push(`${type}大小超过 ${limit / 1_000_000} MB。`);
      if (file.width && file.height && spec.maxPixels && file.width * file.height > spec.maxPixels) {
        errors.push(`${type}总像素超过平台限制。`);
      }
      if (file.width && file.height && (spec.minRatio || spec.maxRatio)) {
        const ratio = file.width / file.height;
        if ((spec.minRatio && ratio < spec.minRatio) || (spec.maxRatio && ratio > spec.maxRatio)) {
          errors.push(`${type}比例超出平台允许范围。`);
        }
      }
      if (file.duration !== null && ((spec.minSeconds && file.duration < spec.minSeconds) ||
                                    (spec.maxSeconds && file.duration > spec.maxSeconds))) {
        errors.push("视频时长超出平台允许范围。");
      }
      if (kind === "video" && file.width && file.height && rule.suggestedRatio &&
          Math.abs(file.width / file.height / rule.suggestedRatio - 1) > 0.12) {
        warnings.push("视频比例与平台推荐比例不同，仍可提交。");
      }
    }
  }

  if (rule.coverRequired && !cover) errors.push("请为视频选择封面。");
  if (payload.coverId && (!cover || cover.status !== "READY" || cover.kind !== "IMAGE")) errors.push("所选封面不可用。");
  if (cover && rule.cover && (!rule.cover.formats.includes(cover.mime) ||
      (rule.cover.maxBytes && Number(cover.bytes) > rule.cover.maxBytes))) errors.push("封面格式或大小不符合平台要求。");
  if (cover && !rule.cover && rule.mode === "direct") warnings.push("该平台的接口不接受单独指定的视频封面。");

  for (const option of rule.options ?? []) {
    const value = payload.options[option.key] ?? option.default;
    const required = option.required || (option.requiredIf && String(payload.options[option.requiredIf.key]) === option.requiredIf.value);
    if (value === undefined || value === "") {
      if (required) errors.push(`请填写${option.label}。`);
      continue;
    }
    let valid = false;
    if (option.type === "check") valid = typeof value === "boolean" && (!required || value);
    if (option.type === "choice") valid = option.choices?.some(choice => choice.value === value) ?? false;
    if (option.type === "number") {
      valid = typeof value === "number" && Number.isInteger(value) && (option.min === undefined || value >= option.min) &&
        (option.max === undefined || value <= option.max);
    }
    if (option.type === "text") valid = typeof value === "string" && (option.max === undefined || value.length <= option.max);
    if (!valid) errors.push(`请核对${option.label}。`);
  }

  for (const forbidden of rule.serverOnly?.textForbidden ?? []) {
    if ([payload.title, payload.body].some(text => text.includes(forbidden))) errors.push("标题或正文中含平台禁止的字符。");
  }
  for (const notice of rule.notices ?? []) {
    if (!notice.when || /https?:\/\//i.test(payload.body)) warnings.push(notice.message);
  }
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

export { formatBody };
