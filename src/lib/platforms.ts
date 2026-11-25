import twitterText from "twitter-text";

export const platformKeys = [
  "youtube", "facebook", "instagram", "threads", "linkedin", "bluesky", "x", "tiktok",
  "douyin", "weibo", "kuaishou", "bilibili", "xiaohongshu", "wechat",
] as const;

export type PlatformKey = typeof platformKeys[number];
export type Language = "ZH" | "EN" | "JA" | "VI";
export const languageLabels: Record<Language, string> = { ZH: "简体中文", EN: "英文", JA: "日文", VI: "越南语" };
export const languageTags: Record<Language, string> = { ZH: "zh-CN", EN: "en", JA: "ja", VI: "vi" };

type Metric = "grapheme" | "utf8" | "utf16" | "x" | "threads";
type Limit = { max: number; metric: Metric };
type MediaRule = { formats: readonly string[]; maxCount: number; maxBytes?: number; minSeconds?: number; maxSeconds?: number; maxPixels?: number; formatBytes?: Record<string, number>; minRatio?: number; maxRatio?: number };

export type PlatformOption = {
  key: string;
  label: string;
  type: "choice" | "text" | "number" | "check";
  required?: boolean;
  requiredIf?: { key: string; value: string };
  choices?: { value: string; label: string }[];
  default?: string | number | boolean;
  min?: number;
  max?: number;
};

export type PlatformRule = {
  label: string;
  region: "domestic" | "international";
  mode: "direct" | "manual";
  body?: Limit;
  title?: Limit;
  image?: MediaRule;
  video?: MediaRule;
  allowText?: boolean;
  allowMixed?: boolean;
  exclusiveImageFormats?: readonly string[];
  maxMedia?: number;
  ownTags?: boolean;
  requiredTitle?: boolean;
  requiredTags?: boolean;
  distinctTargets?: boolean;
  maxTags?: number;
  tagsLimit?: Limit;
  suggestedRatio?: number;
  coverRequired?: boolean;
  coverFor?: "video" | "single-video";
  cover?: MediaRule;
  options?: readonly PlatformOption[];
  backend?: string;
  notices?: readonly { message: string; when?: "link" }[];
  serverOnly?: { textForbidden?: readonly string[] };
};

const MB = 1_000_000;
const image = ["image/jpeg", "image/png", "image/gif"];
const video = ["video/mp4", "video/quicktime"];
const jpeg = ["image/jpeg"];
const body = (max: number, metric: Metric = "grapheme"): Limit => ({ max, metric });
const choice = (values: Record<string, string>) => Object.entries(values).map(([value,label]) => ({ value,label }));
const international = { region: "international", mode: "direct" } as const;
const domestic = { region: "domestic", mode: "direct" } as const;
const manual = { region: "domestic", mode: "manual" } as const;

export const platformRules: Record<PlatformKey, PlatformRule> = {
  youtube: { ...international, label: "YouTube", requiredTitle: true, title: body(100), body: body(5000, "utf8"), ownTags: true,
    video: { formats: video, maxCount: 1 }, cover: { formats: ["image/jpeg", "image/png"], maxCount: 1, maxBytes: 50 * MB },
    options: [
      { key: "privacy", label: "公开范围", type: "choice", choices: choice({ private: "私密", unlisted: "不公开列出", public: "公开" }), required: true },
      { key: "categoryId", label: "视频类别 ID", type: "number", min: 1, default: 22 },
      { key: "madeForKids", label: "内容面向儿童", type: "check" },
    ], serverOnly: { textForbidden: ["<", ">"] },
  },
  facebook: { ...international, label: "Facebook", allowText: true, coverFor: "video", image: { formats: image, maxCount: 10, maxBytes: 10 * MB },
    video: { formats: video, maxCount: 1 }, cover: { formats: jpeg, maxCount: 1 },
    notices: [{ message: "正文上限由 Facebook 公共主页的实际权限和接口返回判定。" }],
  },
  instagram: { ...international, label: "Instagram", coverFor: "single-video", body: body(2200), maxTags: 30, maxMedia: 20, allowMixed: true,
    image: { formats: jpeg, maxCount: 20, maxBytes: 8 * MB, minRatio: 4 / 5, maxRatio: 1.91 },
    video: { formats: video, maxCount: 20, maxBytes: 300 * MB, minSeconds: 3, maxSeconds: 900 },
    cover: { formats: jpeg, maxCount: 1, maxBytes: 8 * MB }, suggestedRatio: 9 / 16,
  },
  threads: { ...international, label: "Threads", allowText: true, body: body(500, "threads"), maxMedia: 20, allowMixed: true,
    image: { formats: ["image/jpeg", "image/png"], maxCount: 20, maxBytes: 8 * MB },
    video: { formats: video, maxCount: 20, maxBytes: 1000 * MB, maxSeconds: 300 }, suggestedRatio: 9 / 16,
  },
  linkedin: { ...international, label: "LinkedIn", allowText: true, coverFor: "video", body: body(3000),
    image: { formats: image, maxCount: 20, maxPixels: 36_152_319 }, video: { formats: ["video/mp4"], maxCount: 1, maxBytes: 500 * MB, minSeconds: 3, maxSeconds: 1800 },
    cover: { formats: jpeg, maxCount: 1 },
  },
  bluesky: { ...international, label: "Bluesky", allowText: true, body: body(300),
    image: { formats: image, maxCount: 4, maxBytes: 2_000_000 },
    video: { formats: ["video/mp4"], maxCount: 1, maxBytes: 100 * MB, maxSeconds: 180 },
  },
  x: { ...international, label: "X", allowText: true, distinctTargets: true, exclusiveImageFormats: ["image/gif"], body: body(280, "x"),
    image: { formats: image, maxCount: 4, maxBytes: 5 * MB, formatBytes: { "image/gif": 15 * MB } }, video: { formats: ["video/mp4"], maxCount: 1, maxSeconds: 1200 },
    notices: [
      { message: "普通发帖预计 0.015 美元/次，含链接预计 0.20 美元/次。费用以 X 开发者控制台为准。" },
      { message: "X 禁止在自营账号间自动发布重复或实质相似的内容。" },
    ],
    options: [{ key: "consent", label: "已确认该账号的自动发布授权和按量费用", type: "check", required: true }],
  },
  tiktok: { ...international, label: "TikTok", body: body(2200, "utf16"),
    image: { formats: ["image/jpeg"], maxCount: 35 }, video: { formats: video, maxCount: 1 },
    notices: [{ message: "此团队内部工具不符合 TikTok 官方直发准入。本平台仅运行模拟任务。" }],
    options: [
      { key: "consent", label: "已查看素材和模拟发布设置", type: "check", required: true },
      { key: "privacy", label: "模拟可见范围", type: "choice", choices: choice({ SELF_ONLY: "仅自己", PUBLIC_TO_EVERYONE: "公开" }), required: true },
      { key: "comments", label: "允许评论（模拟）", type: "check" },
      { key: "duet", label: "允许合拍（模拟）", type: "check" },
      { key: "stitch", label: "允许拼接（模拟）", type: "check" },
    ],
  },
  douyin: { ...domestic, label: "抖音", body: body(1000), image: { formats: image, maxCount: 30, maxBytes: 20 * MB },
    video: { formats: video, maxCount: 1, maxSeconds: 900 }, cover: { formats: jpeg, maxCount: 1, maxBytes: 300 * MB }, suggestedRatio: 9 / 16,
    options: [{ key: "consent", label: "已确认向所选抖音账号发布此次素材、文案和话题", type: "check", required: true }],
  },
  weibo: { ...domestic, label: "微博", allowText: true, image: { formats: image, maxCount: 1, maxBytes: 5 * MB },
    video: { formats: video, maxCount: 1 }, notices: [{ message: "分享、商业文字或单图、视频所需权限各不相同，需应用实际能力核对。" }],
  },
  kuaishou: { ...domestic, label: "快手", video: { formats: video, maxCount: 1 },
    coverRequired: true, cover: { formats: jpeg, maxCount: 1, maxBytes: 10 * MB }, suggestedRatio: 9 / 16,
  },
  bilibili: { ...domestic, label: "哔哩哔哩", requiredTitle: true, requiredTags: true, title: body(79), body: body(249), ownTags: true, tagsLimit: body(199),
    video: { formats: video, maxCount: 1 }, cover: { formats: jpeg, maxCount: 1 }, suggestedRatio: 16 / 9,
    options: [
      { key: "categoryId", label: "二级分区 ID", type: "number", min: 1, required: true },
      { key: "copyright", label: "版权归属", type: "choice", choices: choice({ "1": "原创", "2": "转载" }), required: true },
      { key: "source", label: "转载来源", type: "text", max: 150, requiredIf: { key: "copyright", value: "2" } },
    ],
  },
  xiaohongshu: { ...manual, label: "小红书", backend: "https://creator.xiaohongshu.com/", title: body(20), body: body(1000),
    image: { formats: image, maxCount: 18 }, video: { formats: video, maxCount: 1 }, cover: { formats: jpeg, maxCount: 1 }, suggestedRatio: 3 / 4,
  },
  wechat: { ...manual, label: "微信视频号", backend: "https://channels.weixin.qq.com/",
    image: { formats: image, maxCount: 20 }, video: { formats: video, maxCount: 1 }, cover: { formats: jpeg, maxCount: 1 },
  },
};

export function isPlatform(value: string): value is PlatformKey {
  return Object.hasOwn(platformRules, value);
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const encoder = new TextEncoder();

export function platformLimit(key: PlatformKey, field: "body" | "title" = "body"): number | null {
  return platformRules[key][field]?.max ?? null;
}

export function measureCopy(key: PlatformKey, value: string, field: "body" | "title" = "body"): number {
  const metric = platformRules[key][field]?.metric ?? "grapheme";
  if (metric === "x") return twitterText.parseTweet(value).weightedLength;
  if (metric === "utf8") return encoder.encode(value).length;
  if (metric === "utf16") return value.length;
  const units = [...segmenter.segment(value)];
  if (metric === "threads") {
    return units.reduce((sum, { segment }) => sum + (/\p{Extended_Pictographic}|\p{Emoji_Presentation}/u.test(segment) ? encoder.encode(segment).length : 1), 0);
  }
  return units.length;
}

export type CopyFields = { title: string; body: string; tags: string[] };

export function formatBody(key: PlatformKey, copy: CopyFields): string {
  const rule = platformRules[key];
  const tags = rule.ownTags ? "" : copy.tags.map(tag => "#" + tag.replace(/^#+/, "").trim()).filter(tag => tag !== "#").join(" ");
  return [rule.title ? "" : copy.title.trim(), copy.body.trim(), tags].filter(Boolean).join("\n\n");
}
