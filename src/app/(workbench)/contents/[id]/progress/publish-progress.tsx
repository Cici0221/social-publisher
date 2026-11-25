"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { isPlatform, languageLabels, platformRules } from "@/lib/platforms";
import type { TaskStatus } from "@/generated/prisma/enums";
import { formatPublishTime, localPublishTimeToDate, publishTimeInput, publishZones, type PublishZone } from "@/lib/publish-time";
import { PublishZonePicker, usePublishZone } from "@/ui/publish-zone-picker";
import { ManualDelivery } from "@/ui/manual-delivery";
import type { publicationProgress } from "@/server/publications";

type Progress = Awaited<ReturnType<typeof publicationProgress>>;
export type DeliveryRow = Progress["tasks"][number];

export const deliveryLabel: Record<TaskStatus, string> = {
  WAITING_APPROVAL: "待审核", SCHEDULED: "待定时发布", QUEUED: "排队中",
  UPLOADING: "上传中", PUBLISHING: "发布中", PROCESSING: "平台处理中",
  MANUAL: "待人工发布", SUCCESS: "成功", FAILED: "失败", UNKNOWN: "结果待核对", CANCELLED: "已取消",
};
const ongoing: TaskStatus[] = ["WAITING_APPROVAL", "SCHEDULED", "QUEUED", "UPLOADING", "PUBLISHING", "PROCESSING", "MANUAL"];

function httpsLink(url: string | null) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password ? parsed.href : null;
  } catch { return null; }
}

function ScheduleActions({ row, zone, refresh }: { row: DeliveryRow; zone: PublishZone; refresh: () => Promise<void> }) {
  const [action, setAction] = useState<"reschedule" | "cancel" | null>(null);
  const [value, setValue] = useState("");
  const [editZone, setEditZone] = useState(zone);
  const [working, setWorking] = useState(false);
  const [note, setNote] = useState("");
  async function modify() {
    const time = action === "reschedule" ? localPublishTimeToDate(value, editZone) : null;
    if (action === "reschedule" && !time) { setNote("请选择有效的未来时间。"); return; }
    setWorking(true);
    setNote("");
    try {
      const response = await fetch(`/api/publications/tasks/${row.id}/schedule`, { method: "PATCH",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, runAt: time?.toISOString() }) });
      if (!response.ok) throw new Error((await response.json()).error ?? "未能更新定时。");
      await refresh();
      setAction(null);
    } catch (error) { setNote(error instanceof Error ? error.message : "未能更新定时。"); }
    finally { setWorking(false); }
  }
  return <div className="delivery-options">
    {!action ? <>
      <button type="button" className="button button-outline button-compact" onClick={() => {
        setEditZone(zone); setAction("reschedule"); setValue(publishTimeInput(new Date(row.runAt), zone));
      }}>修改定时</button>
      <button type="button" className="button button-outline button-compact" onClick={() => setAction("cancel")}>取消任务</button>
    </> : <>
      {action === "reschedule" && <label className="form-field"><span>新时间（{publishZones[editZone]}）</span>
        <input type="datetime-local" value={value} onChange={event => setValue(event.target.value)} /></label>}
      <button type="button" className="button button-outline button-compact" disabled={working} onClick={() => setAction(null)}>返回</button>
      <button type="button" className="button button-primary button-compact" disabled={working}
        onClick={() => void modify()}>{action === "cancel" ? "确认取消" : "保存定时"}</button>
    </>}
    {note && <p className="delivery-errors" role="alert">{note}</p>}
  </div>;
}

export function PublishProgress({ initial }: { initial: Progress }) {
  const [progress, setProgress] = useState(initial);
  const [zone, setZone] = usePublishZone();
  const [message, setMessage] = useState("");
  const [working, setWorking] = useState("");
  const refreshSequence = useRef(0);
  const isRunning = progress.tasks.some(row => ongoing.includes(row.status));

  async function refresh(signal?: AbortSignal) {
    const sequence = ++refreshSequence.current;
    try {
      const response = await fetch(`/api/publications/${initial.id}`, { cache: "no-store", signal });
      if (response.ok) {
        const snapshot = await response.json() as Progress;
        if (sequence === refreshSequence.current) setProgress(snapshot);
      }
    } catch { /* An interrupted poll can retry on the next interval. */ }
  }

  useEffect(() => {
    if (!isRunning) return;
    const control = new AbortController();
    const timer = setInterval(() => void refresh(control.signal), 2200);
    return () => { clearInterval(timer); control.abort(); };
  }, [isRunning, initial.id]);

  async function retry(id: string) {
    setWorking(id);
    setMessage("");
    try {
      const response = await fetch(`/api/publications/tasks/${id}`, { method: "POST" });
      if (!response.ok) throw new Error((await response.json()).error ?? "重试失败。");
      refreshSequence.current += 1;
      setProgress(previous => ({ ...previous, tasks: previous.tasks.map(row =>
        row.id === id ? { ...row, status: "QUEUED", errorCode: null, errorMessage: null, retryCount: 0 } : row) }));
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "重试失败。");
    } finally { setWorking(""); }
  }

  return <>
    <div className="delivery-options"><PublishZonePicker zone={zone} setZone={setZone} /></div>
    {progress.status === "RETURNED" && <div className="delivery-errors">
      <p>审核已退回{progress.reviewNote ? ` · ${progress.reviewNote}` : ""}</p>
      {progress.canManage && <Link className="text-link" href={`/contents/${progress.id}`}>继续编辑</Link>}
    </div>}
    <p className="delivery-summary" aria-live="polite"><strong>{progress.tasks.filter(row => row.status === "SUCCESS").length} / {progress.tasks.length}</strong> 个任务成功</p>
    <div className="delivery-stack">
      {progress.tasks.map(row => {
        const label = isPlatform(row.platform) ? platformRules[row.platform].label : row.platform;
        const link = httpsLink(row.postUrl);
        return <article className="delivery-panel" key={row.id}>
          <header className="delivery-panel-heading"><div><h2>{label} · {row.account.name}</h2>
            <p className="muted">{languageLabels[row.language]}{row.mode === "MOCK" && " · 模拟"}</p></div>
            <span className={`delivery-badge ${row.status === "SUCCESS" ? "good" : ["FAILED", "UNKNOWN"].includes(row.status) ? "danger" : ""}`}>
              {deliveryLabel[row.status]}
            </span>
          </header>
          <p className="muted">{row.publishedAt ? `完成于 ${formatPublishTime(new Date(row.publishedAt), zone)}` :
            `计划 ${formatPublishTime(new Date(row.runAt), zone)}`}（{publishZones[zone]}）</p>
          {progress.canManage && ["SCHEDULED", "WAITING_APPROVAL", "QUEUED"].includes(row.status) &&
            <ScheduleActions row={row} zone={zone} refresh={refresh} />}
          {row.errorMessage && <p className={row.status === "SUCCESS" ? "delivery-notes" : "delivery-errors"}>{row.errorMessage}</p>}
          {link && <a className="button button-outline button-compact" href={link} target="_blank" rel="noreferrer">查看已发布帖子</a>}
          {row.status === "MANUAL" && <ManualDelivery taskId={row.id} />}
          {progress.canManage && row.status === "FAILED" && <button type="button" className="button button-outline button-compact" onClick={() => void retry(row.id)}
            disabled={working === row.id}>重试此账号</button>}
        </article>;
      })}
    </div>
    {message && <p role="alert" className="delivery-errors">{message}</p>}
  </>;
}
