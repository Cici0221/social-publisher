import { ArrowLeft, ArrowRight, ClipboardList } from "lucide-react";
import Link from "next/link";
import { pageActor } from "@/server/auth";
import { reviewQueue } from "@/server/reviews";
import styles from "./review.module.css";

export const metadata = { title: "待审核" };
const date = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "medium", timeStyle: "short" });

export default async function ReviewQueuePage({ searchParams }: {
  searchParams: Promise<{ page?: string | string[] }>;
}) {
  const actor = await pageActor("REVIEWER");
  const raw = (await searchParams).page;
  const result = await reviewQueue(actor, typeof raw === "string" ? raw : null);
  return (
    <div className="page-container">
      <header className="page-header">
        <div><h1>待审核</h1><p className="muted">核对提交的文案、素材、目标账号和发布时间。</p></div>
      </header>
      <section className="panel" aria-label="待审核内容">
        <header className="panel-header"><h2 className="section-title">审核队列</h2>
          <span className="muted small">{result.total} 项待处理</span></header>
        {result.items.length ? <div className={styles.queue}>
          {result.items.map(row => <Link className={styles.queueItem} key={row.id} href={`/review/${row.id}`}>
            <span><strong>{row.title}</strong><small>{row.editor}{row.submittedAt ? " · " + date.format(new Date(row.submittedAt)) : ""}</small></span>
            <span className={styles.targetCount}>{row.targets} 个发布账号</span><ArrowRight size={17} aria-hidden="true" />
          </Link>)}
        </div> : <div className={styles.empty}><ClipboardList size={28} strokeWidth={1.5} aria-hidden="true" />
          <p>这一页没有待审核内容。</p></div>}
        {(result.pages > 1 || result.page > 1) && <nav className={styles.pagination} aria-label="待审核分页">
          {result.page > 1 && <Link className="icon-button" href={`/review?page=${result.page - 1}`} aria-label="上一页">
            <ArrowLeft size={16} aria-hidden="true" /></Link>}
          <span>{result.page} / {result.pages}</span>
          {result.page < result.pages && <Link className="icon-button" href={`/review?page=${result.page + 1}`} aria-label="下一页">
            <ArrowRight size={16} aria-hidden="true" /></Link>}
        </nav>}
      </section>
    </div>
  );
}
