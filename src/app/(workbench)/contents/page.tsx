import Link from "next/link";
import { ArrowUpRight, FileText } from "lucide-react";
import { pageActor } from "@/server/auth";
import { draftPageNumber, listDrafts } from "@/server/drafts";
import NewDraftButton from "./new-draft";
import styles from "./contents.module.css";

const updatedFormat = new Intl.DateTimeFormat("zh-CN", {
  dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Shanghai",
});

export default async function ContentsPage({ searchParams }: { searchParams: Promise<{ page?: string | string[] }> }) {
  const actor = await pageActor("ADMIN", "EDITOR");
  const { page: rawPage } = await searchParams;
  const page = draftPageNumber(typeof rawPage === "string" ? rawPage : undefined);
  const { drafts, hasMore } = await listDrafts(actor.id, page);

  return <section className={`page-container ${styles.page}`}>
    <header className={styles.heading}>
      <div><h1>草稿箱</h1><p>继续撰写、准备素材和选择发布账号。</p></div>
      <NewDraftButton />
    </header>
    {drafts.length ? <div className={styles.list}>
      {drafts.map(item => <Link className={styles.draftRow} key={item.id} href={`/contents/${item.id}`}>
        <span className={styles.draftIcon}><FileText size={19} aria-hidden="true" /></span>
        <span className={styles.rowSummary}><strong>{item.title}</strong>
          <span>{item.status === "RETURNED" ? "审核退回" : "草稿"} · <time dateTime={item.updatedAt}>{updatedFormat.format(new Date(item.updatedAt))}</time></span>
        </span>
        <ArrowUpRight size={18} aria-hidden="true" />
      </Link>)}
    </div> : <div className={styles.empty}>
      <FileText size={30} strokeWidth={1.4} aria-hidden="true" />
      <h2>{page > 1 ? "本页没有草稿" : "还没有草稿"}</h2>
    </div>}
    {(page > 1 || hasMore) && <nav className={styles.pagination} aria-label="草稿分页">
      {page > 1 && <Link className="button button-outline button-compact" href={page === 2 ? "/contents" : `/contents?page=${page - 1}`}>上一页</Link>}
      <span>第 {page} 页</span>
      {hasMore && <Link className="button button-outline button-compact" href={`/contents?page=${page + 1}`}>下一页</Link>}
    </nav>}
  </section>;
}
