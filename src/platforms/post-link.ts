import { isPlatform, type PlatformKey } from "@/lib/platforms";
import { isManualPlatform, manualPolicies, manualUrl } from "./manual-policy";

type PostLinkRule = { hosts: readonly string[]; matches: (url: URL) => boolean; canonical?: (url: URL) => string };

const youtubePrivateEmbedHosts = ["www.youtube-nocookie.com", "youtube-nocookie.com"];
const youtubeEmbed = /^\/embed\/[\w-]+\/?$/;
const linkedInUrn = /^\/(?:embed\/)?feed\/update\/urn(?::|%3A)li(?::|%3A)(?:share|ugcPost|activity)(?::|%3A)\d+\/?$/i;
const douyinShareHosts = ["www.iesdouyin.com", "iesdouyin.com"];

const officialPosts: Partial<Record<PlatformKey, PostLinkRule>> = {
  x: {
    hosts: ["x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"],
    matches: url => /^\/(?:[\w]+|i\/web)\/status\/\d+\/?$/.test(url.pathname),
  },
  youtube: {
    hosts: ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", ...youtubePrivateEmbedHosts],
    matches(url) {
      if (youtubePrivateEmbedHosts.includes(url.hostname)) return youtubeEmbed.test(url.pathname);
      if (url.hostname === "youtu.be") return /^\/[\w-]+\/?$/.test(url.pathname);
      return /^\/(?:shorts|live|embed)\/[\w-]+\/?$/.test(url.pathname) ||
        (url.pathname === "/watch" && /^[\w-]+$/.test(url.searchParams.get("v") ?? ""));
    },
    canonical: url => youtubePrivateEmbedHosts.includes(url.hostname)
      ? `https://www.youtube.com/watch?v=${url.pathname.slice("/embed/".length).replace(/\/$/, "")}` : url.href,
  },
  facebook: {
    hosts: ["facebook.com", "www.facebook.com", "m.facebook.com", "fb.watch"],
    matches: url => url.hostname === "fb.watch" ? /^\/[\w-]+\/?$/.test(url.pathname) :
      /^(?:\/[^/]+)?\/(?:posts|videos|reel|share)\/(?:[rPv]\/)?[\w.-]+\/?$/i.test(url.pathname) ||
      /^\/\d+_\d+\/?$/.test(url.pathname) ||
      (/^\/(?:story|permalink)\.php$/.test(url.pathname) && url.searchParams.has("story_fbid")) ||
      (/^\/(?:watch\/?|video\.php)$/.test(url.pathname) && url.searchParams.has("v")) ||
      (/^\/photo(?:\.php|\/)?$/.test(url.pathname) && url.searchParams.has("fbid")),
  },
  instagram: {
    hosts: ["instagram.com", "www.instagram.com"],
    matches: url => /^(?:\/[\w.]+)?\/(?:p|reel|tv)\/[\w-]+\/?$/.test(url.pathname),
  },
  threads: {
    hosts: ["threads.com", "www.threads.com", "threads.net", "www.threads.net"],
    matches: url => /^\/@[\w.]+\/post\/[\w-]+\/?$/.test(url.pathname),
  },
  linkedin: {
    hosts: ["linkedin.com", "www.linkedin.com"],
    matches: url => /^\/posts\/[\w%-]+\/?$/.test(url.pathname) || linkedInUrn.test(url.pathname),
    canonical: url => url.pathname.startsWith("/embed/") ? `https://www.linkedin.com${url.pathname.slice(6)}` : url.href,
  },
  bluesky: {
    hosts: ["bsky.app"],
    matches: url => /^\/profile\/[\w.:%-]+\/post\/[\w-]+\/?$/.test(url.pathname),
  },
  tiktok: {
    hosts: ["tiktok.com", "www.tiktok.com", "vm.tiktok.com", "vt.tiktok.com"],
    matches: url => url.hostname === "vm.tiktok.com" || url.hostname === "vt.tiktok.com"
      ? /^\/[\w-]+\/?$/.test(url.pathname)
      : /^\/(?:@[\w.]+\/(?:video|photo)|player\/v1)\/\d+\/?$/.test(url.pathname),
  },
  douyin: {
    hosts: ["douyin.com", "www.douyin.com", "v.douyin.com", ...douyinShareHosts],
    matches(url) {
      if (url.hostname === "v.douyin.com") return /^\/[\w-]+\/?$/.test(url.pathname);
      if (douyinShareHosts.includes(url.hostname)) return /^\/share\/video\/[\w-]+={0,2}\/?$/.test(url.pathname);
      return /^\/(?:video|note|slides)\/\d+\/?$/.test(url.pathname);
    },
  },
  kuaishou: {
    hosts: ["kuaishou.com", "www.kuaishou.com", "v.kuaishou.com"],
    matches: url => url.hostname === "v.kuaishou.com" ? /^\/[\w-]+\/?$/.test(url.pathname) : /^\/short-video\/[\w-]+\/?$/.test(url.pathname),
  },
  weibo: {
    hosts: ["weibo.com", "www.weibo.com", "weibo.cn", "www.weibo.cn", "m.weibo.cn"],
    matches: url => /^\/(?:detail|status|\d+)\/[\w]+\/?$/.test(url.pathname),
  },
  bilibili: {
    hosts: ["bilibili.com", "www.bilibili.com", "m.bilibili.com", "b23.tv"],
    matches: url => url.hostname === "b23.tv" ? /^\/[\w-]+\/?$/.test(url.pathname) : /^\/video\/(?:BV|av)\w+\/?$/.test(url.pathname),
  },
};

function officialHttpsUrl(value: string, hosts: readonly string[]) {
  const url = URL.parse(value);
  if (!url || url.protocol !== "https:" || url.port || url.username || url.password || !hosts.includes(url.hostname)) return null;
  return url;
}

export function officialPublicationLink(platform: string, value: string): string | null {
  if (isManualPlatform(platform)) return manualUrl(platform, value, "post");
  const rule = isPlatform(platform) ? officialPosts[platform] : undefined;
  const url = rule && officialHttpsUrl(value, rule.hosts);
  if (!url || !rule.matches(url)) return null;
  return rule.canonical?.(url) ?? url.href;
}

export function officialPublicationEvidenceLink(platform: string, value: string): string | null {
  const hosts = isManualPlatform(platform) ? manualPolicies[platform].postHosts :
    isPlatform(platform) ? officialPosts[platform]?.hosts : undefined;
  const url = hosts && officialHttpsUrl(value, hosts);
  if (!url || url.pathname === "/") return null;
  // Evidence in the audit log is plain text. Omit query strings and fragments that may contain access tokens.
  return url.origin + url.pathname;
}
