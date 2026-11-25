import { db } from "./db";

const pageSize = 30;

export function parseInboxParams(params: Pick<URLSearchParams, "get">) {
  const page = Number.parseInt(params.get("page") ?? "1", 10) || 1;
  return { unread: params.get("unread") === "1", page: Math.max(1, Math.min(2_000_000, page)) };
}

export async function listInbox(userId: string, { unread, page }: ReturnType<typeof parseInboxParams>) {
  const [rows, unreadCount] = await Promise.all([
    db().notification.findMany({
      where: { userId, ...(unread ? { readAt: null } : {}) },
      select: { id: true, kind: true, message: true, href: true, createdAt: true, readAt: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: pageSize + 1, skip: (page - 1) * pageSize,
    }),
    db().notification.count({ where: { userId, readAt: null } }),
  ]);
  return { rows: rows.slice(0, pageSize), hasMore: rows.length > pageSize, unreadCount };
}

export async function markInboxRead(userId: string, id?: string) {
  const result = await db().notification.updateMany({
    where: { userId, readAt: null, ...(id ? { id } : {}) },
    data: { readAt: new Date() },
  });
  return result.count;
}

export function inboxHref(href: string | null) {
  if (!href || !href.startsWith("/") || href.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(href)) return null;
  try {
    const base = "https://publisher.invalid";
    const url = new URL(href, base);
    return url.origin === base ? url.pathname + url.search + url.hash : null;
  } catch {
    return null;
  }
}
