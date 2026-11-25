import { ArrowDownToLine, ArrowLeft, CalendarClock, FileVideo2, ImageIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { languageLabels } from "@/lib/platforms";
import { pageActor } from "@/server/auth";
import { AppError } from "@/server/errors";
import { reviewingContent } from "@/server/reviews";
import styles from "../review.module.css";
import { ReviewForm } from "./review-form";

export const metadata = { title: "审核详情" };
const date = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "medium", timeStyle: "short" });
const modeLabels = { LIVE: "官方接口", MOCK: "模拟发布", MANUAL: "人工发布" };

type ReviewAsset = Awaited<ReturnType<typeof reviewingContent>>["items"][number]["media"][number];

function ReviewMedia({ asset, cover = false }: { asset: ReviewAsset; cover?: boolean }) {
  return <li className={styles.asset}>
    {asset.ready ? <img src={`/api/assets/${asset.id}/thumbnail`} alt="" loading="lazy" />
      : asset.kind === "VIDEO" ? <FileVideo2 size={23} aria-hidden="true" /> : <ImageIcon size={23} aria-hidden="true" />}
    <span><strong>{asset.filename}</strong><small>{cover ? "视频封面" : asset.kind === "VIDEO" ? "视频" : "图片"}</small></span>
    {asset.ready ? <a className="icon-button" href={`/api/assets/${asset.id}/file`}
      aria-label={`下载 ${asset.filename}`} title="下载原件"><ArrowDownToLine size={16} aria-hidden="true" /></a>
      : <small>不可用</small>}
  </li>;
}

export default async function ReviewPage({ params }: { params: Promise<{ contentId: string }> }) {
  const actor = await pageActor("REVIEWER");
  const { contentId } = await params;
  const result = await reviewingContent(actor, contentId).catch(error => {
    if (error instanceof AppError && error.status === 404) notFound();
    throw error;
  });
  return <div className="page-container">
    <Link href="/review" className={`text-link ${styles.back}`}><ArrowLeft size={16} aria-hidden="true" />返回待审核</Link>
    <header className="page-header">
      <div><h1>{result.title}</h1><p className="muted">{result.editor} 提交
        {result.submittedAt ? " · " + date.format(new Date(result.submittedAt)) + "（北京时间）" : ""}</p></div>
    </header>
    <div className={styles.detailLayout}>
      <section className={styles.snapshots} aria-label="提交快照">
        {result.items.length ? result.items.map(task => <article className="panel" key={task.id}>
          <header className={styles.cardHeader}><div><h2>{task.platform}</h2><p>{task.accountName}</p></div>
            <span className="state-tag">{modeLabels[task.mode]}</span></header>
          <div className={styles.cardBody}>
            <div className={styles.schedule}><CalendarClock size={16} aria-hidden="true" />
              {task.scheduled ? date.format(new Date(task.runAt)) + "（北京时间）" : "审核通过后尽快发布"}
              <span>{languageLabels[task.language]}</span></div>
            {task.copy?.title && <h3>{task.copy.title}</h3>}
            {task.copy?.body && <p className={styles.copy}>{task.copy.body}</p>}
            {task.copy?.tags.length ? <ul className={styles.tags} aria-label="话题标签">{task.copy.tags.map((tag, index) =>
              <li key={tag + index}>{tag}</li>)}</ul> : null}
            {task.options.length > 0 && <dl className={styles.options}>{task.options.map(option => <div key={option.label}>
              <dt>{option.label}</dt><dd>{option.value}</dd></div>)}</dl>}
            {task.media.length > 0 || task.cover ? <ul className={styles.media} aria-label="所用素材">
              {task.media.map((asset, index) => <ReviewMedia asset={asset} key={asset.id + index} />)}
              {task.cover && <ReviewMedia asset={task.cover} cover />}
            </ul> : null}
            {!task.valid && <p className={styles.error}>该账号的提交快照无法完整读取。</p>}
          </div>
        </article>) : <p className={styles.error}>这条内容没有可审核的发布任务，可填写意见并退回。</p>}
      </section>
      <ReviewForm contentId={result.id} revision={result.revision} canApprove={result.canApprove} />
    </div>
  </div>;
}
