import { isIP } from "node:net";
import { measureCopy, platformLimit } from "@/lib/platforms";
import { endpoint, expiresIn, form, platformJson, requireEnv } from "../http";
import { type AdapterContext, type Credentials, type PlatformAdapter, ProviderError } from "../types";

const api = "https://api.weibo.com";
const clientId = () => requireEnv("WEIBO_CLIENT_ID");
const reason = "微博公开分享要求真实操作者 IP、明确告知、已登记域名链接。真实 IP 采集与披露确认待部署接入，商业写入与视频能力需平台确认。";

type WeiboToken = { access_token?: string; expires_in?: number; uid?: string; error_code?: number };
type TokenInfo = { uid?: string; expire_in?: number; appkey?: string; error_code?: number };
type PostResponse = { idstr?: string; user?: { idstr?: string }; text?: string; error_code?: number };

// A trusted delivery context is populated only by a server-owned, verified ingress.
// Submitted options and operator-provided IP translations may not populate it.
type TrustedContext = AdapterContext & { weiboOperator?: { verifiedIp: string; disclosureConfirmed: boolean } };

async function weibo<T extends { error_code?: number }>(url: string, init?: RequestInit): Promise<T> {
  const data = await platformJson<T>(url, init);
  if (data && typeof data === "object" && (!data.error_code || data.error_code === 0)) return data;
  const code = data?.error_code;
  if (code === 21314 || code === 21327 || code === 21332) {
    throw new ProviderError("weibo_authorization", "微博网站授权已失效，请重新授权。", { definite: true, reauth: true });
  }
  if (typeof code === "number") {
    throw new ProviderError("weibo_" + code, "微博拒绝分享，请检查授权、网络来源或安全域名。", { definite: true });
  }
  throw new ProviderError("weibo_response", "微博没有返回可识别的结果。", { retryable: true });
}

function sharePayload(context: TrustedContext) {
  const ip = context.weiboOperator?.verifiedIp;
  if (!ip || isIP(ip) !== 4 || context.weiboOperator?.disclosureConfirmed !== true) {
    throw new ProviderError("weibo_operator", reason, { definite: true });
  }
  const body = context.payload.body;
  if (context.payload.tags.length || /#[^#\n]+#/u.test(body)) {
    throw new ProviderError("weibo_topics", "微博公开分享接口不接受话题词。", { definite: true });
  }
  const domain = requireEnv("WEIBO_SAFE_SHARE_DOMAIN").toLowerCase();
  const sharedLink = (body.match(/https?:\/\/[^\s<>，。；！？]+/gu) ?? []).some(raw => {
    try {
      const url = new URL(raw);
      return url.hostname === domain && !url.username && !url.password;
    } catch { return false; }
  });
  if (!sharedLink || measureCopy("weibo", body) > (platformLimit("weibo") ?? 140)) {
    throw new ProviderError("weibo_share", "请填写已登记安全域名下的实际链接，微博分享文案不得超过 140 字。", { definite: true });
  }
  const image = context.media[0];
  if (context.media.length > 1 || (image && image.kind !== "IMAGE")) {
    throw new ProviderError("weibo_media", "微博公开分享仅接受单张图片。视频发布需平台提供相应接口。", { definite: true });
  }
  return { ip, body, image };
}

export const weiboAdapter: PlatformAdapter = {
  key: "weibo",
  availability: () => ({ available: false, reason }),
  authorize: ({ redirectUri, state }) => endpoint(api + "/oauth2/authorize", {
    client_id: clientId(), redirect_uri: redirectUri, response_type: "code", state,
  }),
  exchange: async ({ redirectUri, code }) => {
    const result = await weibo<WeiboToken>(api + "/oauth2/access_token", {
      method: "POST", body: form({ client_id: clientId(), client_secret: requireEnv("WEIBO_CLIENT_SECRET"),
        grant_type: "authorization_code", redirect_uri: redirectUri, code }),
    });
    if (!result.access_token || !result.uid) {
      throw new ProviderError("weibo_token", "微博未返回有效账号授权。", { definite: true });
    }
    return [{ externalId: result.uid, accountName: "微博账号 " + result.uid.slice(-6),
      accessToken: result.access_token, expiresAt: expiresIn(result.expires_in) }];
  },
  refresh: async () => null,
  verify: async (credentials: Credentials) => {
    const details = await weibo<TokenInfo>(api + "/oauth2/get_token_info", {
      method: "POST", body: form({ access_token: credentials.accessToken }),
    });
    if (details.uid !== credentials.externalId || String(details.appkey) !== clientId() || !(Number(details.expire_in) > 0)) {
      throw new ProviderError("weibo_identity", "微博授权账号、应用或有效期无法确认。", { definite: true, reauth: true });
    }
  },
  validate: async context => { sharePayload(context); },
  uploadMedia: async context => {
    sharePayload(context);
    return { kind: "ready" };
  },
  publish: async context => {
    const known = context.externalId ?? (typeof context.state.weiboId === "string" ? context.state.weiboId : undefined);
    if (known) return { kind: "pending", externalId: known };
    const { body, ip, image } = sharePayload(context);
    const fields = { status: body, rip: ip, access_token: context.credentials.accessToken };
    let data: URLSearchParams | FormData = form(fields);
    if (image) {
      data = new FormData();
      for (const [key, value] of Object.entries(fields)) data.set(key, value);
      data.set("pic", new Blob([Uint8Array.from(await image.read())], { type: image.mime }), image.filename);
    }
    await context.beginSubmission();
    const posted = await weibo<PostResponse>(api + "/2/statuses/share.json", { method: "POST", body: data });
    const id = posted.idstr;
    if (!id || !/^\d{1,30}$/.test(id)) {
      throw new ProviderError("weibo_submission", "微博未返回作品编号，提交结果待核对。");
    }
    await context.checkpoint({ ...context.state, weiboId: id });
    return { kind: "pending", externalId: id };
  },
  queryStatus: async context => {
    const id = context.externalId ?? (typeof context.state.weiboId === "string" ? context.state.weiboId : undefined);
    if (!id) return { kind: "unknown" };
    const post = await weibo<PostResponse>(endpoint(api + "/2/statuses/show.json", {
      access_token: context.credentials.accessToken, id,
    }));
    if (post.idstr === id && post.user?.idstr === context.credentials.externalId) {
      return { kind: "success", externalId: id, url: "https://m.weibo.cn/detail/" + id };
    }
    return { kind: "pending", externalId: id };
  },
};
