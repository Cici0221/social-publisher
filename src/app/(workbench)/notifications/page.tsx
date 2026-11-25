import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { formatPublishTime } from "@/lib/publish-time";
import { pageActor } from "@/server/auth";
import { inboxHref, listInbox, parseInboxParams } from "@/server/notification-read";
import { ReadNotificationButton } from "./read-button";
import styles from "./notifications.module.css";

export const metadata: Metadata = { title: "站内通知" };

const kindLabels: Record<string, string> = {
  success: "发布成功",
  publish_success: "发布成功",
  failed: "发布失败",
  unknown: "结果待核对",
  review_waiting: "待审核",
  review_approved: "审核通过",
  review_returned: "审核退回",
  account_expiring: "账号授权",
  manual: "待人工发布",
};

function inboxPage(unread: boolean, page: number) {
  const query = new URLSearchParams();
  if (unread) query.set("unread", "1");
  if (page > 1) query.set("page", String(page));
  return "/notifications" + (query.size ? "?" + query : "");
}

export default async function NotificationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const actor = await pageActor();
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) if (typeof value === "string") query.set(key, value);
  const options = parseInboxParams(query);
  const { rows, unreadCount, hasMore } = await listInbox(actor.id, options);

  return <div className="page-container">
    <header className="page-header">
      <div><h1>站内通知</h1><p className="muted">{unreadCount} 条未读</p></div>
      {unreadCount > 0 && <ReadNotificationButton />}
    </header>
    <section className={`panel ${styles.inbox}`} aria-label="个人通知收件箱">
      <nav className={styles.tabs} aria-label="通知筛选">
        <Link href="/notifications" aria-current={options.unread ? undefined : "page"}>全部</Link>
        <Link href="/notifications?unread=1" aria-current={options.unread ? "page" : undefined}>未读</Link>
      </nav>
      {rows.length ? <ul className={styles.rows}>{rows.map(row => {
        const href = inboxHref(row.href);
        return <li key={row.id} className={row.readAt ? undefined : styles.unread}>
          <div className={styles.message}>
            <div className={styles.meta}>
              <span className="delivery-badge">{kindLabels[row.kind] ?? "系统通知"}</span>
              <time dateTime={row.createdAt.toISOString()}>{formatPublishTime(row.createdAt)}</time>
              {!row.readAt && <span className={styles.unreadText}>未读</span>}
            </div>
            <p>{row.message}</p>
          </div>
          <div className={styles.actions}>
            {href && <Link className="text-link" href={href}>查看相关内容</Link>}
            {!row.readAt && <ReadNotificationButton id={row.id} />}
          </div>
        </li>;
      })}</ul> : <p className={styles.empty}>{options.unread ? "当前没有未读通知。" : "当前没有通知。"}</p>}
    </section>
    {(options.page > 1 || hasMore) && <nav className={styles.pagination} aria-label="通知分页">
      {options.page > 1 && <Link href={inboxPage(options.unread, options.page - 1)} className="button button-outline button-compact">
        <ChevronLeft size={15} aria-hidden="true" /> 上一页
      </Link>}
      <span className="small muted">第 {options.page} 页</span>
      {hasMore && <Link href={inboxPage(options.unread, options.page + 1)} className="button button-outline button-compact">
        下一页 <ChevronRight size={15} aria-hidden="true" />
      </Link>}
    </nav>}
  </div>;
}
