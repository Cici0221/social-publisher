"use client";

import { useEffect, useState } from "react";
import { isPlatform, languageLabels, platformRules } from "@/lib/platforms";
import type { TaskStatus } from "@/generated/prisma/enums";
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

export function PublishProgress({ initial }: { initial: Progress }) {
  const [progress, setProgress] = useState(initial);
  const [message, setMessage] = useState("");
  const [working, setWorking] = useState("");
  const isRunning = progress.tasks.some(row => ongoing.includes(row.status));

  async function refresh(signal?: AbortSignal) {
    try {
      const response = await fetch(`/api/publications/${initial.id}`, { cache: "no-store", signal });
      if (response.ok) setProgress(await response.json());
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
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "重试失败。");
    } finally { setWorking(""); }
  }

  return <>
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
          {row.errorMessage && <p className="delivery-errors">{row.errorMessage}</p>}
          {link && <a className="button button-outline button-compact" href={link} target="_blank" rel="noreferrer">查看已发布帖子</a>}
          {row.status === "FAILED" && <button type="button" className="button button-outline button-compact" onClick={() => void retry(row.id)}
            disabled={working === row.id}>重试此账号</button>}
        </article>;
      })}
    </div>
    {message && <p role="alert" className="delivery-errors">{message}</p>}
  </>;
}
