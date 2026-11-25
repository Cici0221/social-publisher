import { ArrowLeft, ArrowRight, Download, ExternalLink } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { languageLabels, platformKeys, platformRules } from "@/lib/platforms";
import { formatPublishTime, publishZones } from "@/lib/publish-time";
import { pageActor } from "@/server/auth";
import { AppError } from "@/server/errors";
import {
  copyText, historyPublishers, listHistory, modeLabel, parseHistoryFilters, platformLabel,
  recordCopyLabel, statusLabels, verifiedPostUrl, type HistoryFilters, type HistoryRow,
} from "@/server/history";
import { CopyHistoryButton } from "./copy-history-button";
import styles from "./records.module.css";

export const metadata: Metadata = { title: "发布记录" };

function queryOf(values: Record<string, string | string[] | undefined>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    const field = Array.isArray(value) ? value[0] : value;
    if (field) query.set(key, field);
  }
  return query;
}

function hrefWithPage(query: URLSearchParams, page: number) {
  const copy = new URLSearchParams(query);
  if (page === 1) copy.delete("page");
  else copy.set("page", String(page));
  return "/history" + (copy.size ? "?" + copy : "");
}

function HistoryTable({ rows, zone }: { rows: HistoryRow[]; zone: HistoryFilters["zone"] }) {
  return <div className="table-scroll" tabIndex={0} role="region" aria-label="发布记录明细">
    <table className={`data-table ${styles.recordsTable}`}>
      <thead><tr><th scope="col">内容与文案</th><th scope="col">平台账号</th><th scope="col">发布时间 / 计划时间</th><th scope="col">发布人</th><th scope="col">状态</th><th scope="col">操作</th></tr></thead>
      <tbody>{rows.map(row => {
        const copy = copyText(row.payload);
        const label = platformLabel(row.platform);
        const tone = row.status === "SUCCESS" ? " good" : ["FAILED", "UNKNOWN"].includes(row.status) ? " danger" : "";
        const name = copy.title.trim() || copy.body.split("\n")[0]?.trim() || "未命名内容";
        const link = row.mode === "MOCK" ? null : verifiedPostUrl(row.postUrl);
        const eventTime = row.publishedAt ?? row.runAt;
        return <tr key={row.id}>
          <th scope="row">
            <div className={styles.recordSummary}>
              <Link href={`/contents/${row.contentId}/progress`} className="text-link">{name}</Link>
              <span className="small muted">{languageLabels[row.language]}</span>
            </div>
            <details className={styles.expander}>
              <summary>{recordCopyLabel(row)}</summary>
              {copy.title && <strong className={styles.copyTitle}>{copy.title}</strong>}
              {copy.body && <pre className={styles.copyBody}>{copy.body}</pre>}
              {copy.tags.length > 0 && <p className="small muted">{copy.tags.map(tag => "#" + tag.replace(/^#+/, "")).join(" ")}</p>}
              {!copy.body && !copy.title && !copy.tags.length && <p className="small muted">无文案</p>}
            </details>
          </th>
          <td><div className={styles.stack}><strong>{label}</strong><span className="small muted">{row.account.name}</span></div></td>
          <td><div className={styles.stack}>
            <time dateTime={eventTime.toISOString()}>{formatPublishTime(eventTime, zone)}</time>
            <span className="small muted">{!row.publishedAt ? "计划" : row.mode === "MOCK" ? "模拟完成" : row.mode === "MANUAL" ? "人工确认" : "实际发布"}</span>
          </div></td>
          <td><div className={styles.stack}><span>{row.publisher.name}</span>
            {row.confirmer && <span className="small muted">确认人 {row.confirmer.name}</span>}
          </div></td>
          <td><div className={styles.stack}>
            <span className={`delivery-badge${tone}`}>{statusLabels[row.status]}</span>
            <span className="small muted">{modeLabel(row.mode)}</span>
            {row.errorMessage && <span className={styles.recordError}>{row.errorMessage}</span>}
          </div></td>
          <td><div className={styles.stack}>
            <CopyHistoryButton contentId={row.contentId} />
            {link && <a className="text-link" href={link} target="_blank" rel="noreferrer">帖子 <ExternalLink size={13} aria-hidden="true" /></a>}
          </div></td>
        </tr>;
      })}</tbody>
    </table>
  </div>;
}

export default async function HistoryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const actor = await pageActor("ADMIN", "EDITOR");
  const query = queryOf(await searchParams);
  let filters: HistoryFilters;
  let error: string | undefined;
  try {
    filters = parseHistoryFilters(query);
  } catch (caught) {
    if (!(caught instanceof AppError)) throw caught;
    error = caught.message;
    filters = parseHistoryFilters(new URLSearchParams());
  }
  const [result, publishers] = await Promise.all([
    error ? Promise.resolve({ rows: [], hasMore: false }) : listHistory(actor, filters),
    historyPublishers(actor.role),
  ]);
  const exportQuery = new URLSearchParams(query);
  exportQuery.delete("page");

  return <div className="page-container">
    <header className="page-header">
      <div><h1>发布记录</h1><p className="muted">按平台账号核对发布状态、实际文案和帖子链接。</p></div>
      {!error && <a className="button button-outline" href={`/api/history/export${exportQuery.size ? "?" + exportQuery : ""}`}>
        <Download size={17} aria-hidden="true" /> 导出 CSV
      </a>}
    </header>
    <form className={`panel ${styles.filters}`} method="get" action="/history" aria-label="筛选发布记录">
      <div className={styles.filterFields}>
        <label className="field"><span>平台</span><select name="platform" defaultValue={filters.platform ?? ""}>
          <option value="">全部平台</option>
          {platformKeys.map(key => <option key={key} value={key}>{platformRules[key].label}</option>)}
        </select></label>
        <label className="field"><span>状态</span><select name="status" defaultValue={filters.status ?? ""}>
          <option value="">全部状态</option>
          {Object.entries(statusLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select></label>
        {actor.role === "ADMIN" && <label className="field"><span>发布人</span><select name="publisher" defaultValue={filters.publisherId ?? ""}>
          <option value="">全部成员</option>
          {publishers.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}
        </select></label>}
        <label className="field"><span>开始日期</span><input type="date" name="from" defaultValue={filters.from ?? ""} /></label>
        <label className="field"><span>结束日期</span><input type="date" name="through" defaultValue={filters.through ?? ""} /></label>
        <label className="field"><span>显示时区</span><select name="zone" defaultValue={filters.zone}>
          {Object.entries(publishZones).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select></label>
      </div>
      <div className="form-actions">
        <button type="submit" className="button button-primary">应用筛选</button>
        <Link className="text-link" href="/history">清除筛选</Link>
        <span className="small muted">日期按实际发布时间筛选，未发布任务使用计划时间。</span>
      </div>
      {error && <p role="alert" className="feedback feedback-error">{error}</p>}
    </form>
    <section className={`panel ${styles.results}`} aria-label="发布记录">
      {result.rows.length ? <HistoryTable rows={result.rows} zone={filters.zone} /> :
        <p className={styles.empty}>{error ? "调整筛选条件后查看记录。" : "当前没有符合条件的记录。"}</p>}
    </section>
    {!error && (filters.page > 1 || result.hasMore) && <nav className={styles.pagination} aria-label="发布记录分页">
      {filters.page > 1 && <Link className="button button-outline button-compact" href={hrefWithPage(query, filters.page - 1)}><ArrowLeft size={15} aria-hidden="true" /> 上一页</Link>}
      <span className="small muted">第 {filters.page} 页</span>
      {result.hasMore && <Link className="button button-outline button-compact" href={hrefWithPage(query, filters.page + 1)}>下一页 <ArrowRight size={15} aria-hidden="true" /></Link>}
    </nav>}
  </div>;
}
