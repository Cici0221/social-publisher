"use client";

import { Copy, Download, ExternalLink } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";

type Delivery = {
  platformLabel: string; accountName: string; backendUrl: string; title: string; body: string;
  copy: string; hasTitle: boolean; postUrl: string | null; publishedAt: string | null; canConfirm: boolean; canDownload: boolean;
};

function errorText(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function ManualDelivery({ taskId }: { taskId: string }) {
  const router = useRouter();
  const [delivery, setDelivery] = useState<Delivery | null>(null);
  const [postUrl, setPostUrl] = useState("");
  const [actualTitle, setActualTitle] = useState("");
  const [actualBody, setActualBody] = useState("");
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [saving, setSaving] = useState(false);
  const copyField = useRef<HTMLTextAreaElement>(null);
  const api = `/api/publications/tasks/${encodeURIComponent(taskId)}`;

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      setError("");
      try {
        const response = await fetch(api + "/manual", { cache: "no-store", signal: controller.signal });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
        setDelivery(result);
        setActualTitle(result.title);
        setActualBody(result.body);
      } catch (error) {
        if (!controller.signal.aborted) setError(errorText(error, "无法读取人工发布任务。"));
      }
    })();
    return () => controller.abort();
  }, [api]);

  async function copy() {
    if (!delivery) return;
    setFeedback("");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(delivery.copy);
      setFeedback("文案已复制。");
    } catch {
      copyField.current?.focus();
      copyField.current?.select();
      setFeedback("已选中文案，可按系统的复制快捷键。");
    }
  }

  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!delivery?.canConfirm || saving) return;
    setSaving(true);
    setError("");
    setFeedback("");
    try {
      const response = await fetch(api + "/manual", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          postUrl, actualTitle: delivery.hasTitle && actualTitle !== delivery.title ? actualTitle : undefined,
          actualBody: actualBody !== delivery.body ? actualBody : undefined,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setDelivery({ ...delivery, postUrl: result.postUrl, publishedAt: result.publishedAt, canConfirm: false });
      setFeedback("链接已回填，任务已确认发布。");
      router.refresh();
    } catch (error) {
      setError(errorText(error, "暂时无法回填链接，请重试。"));
    } finally {
      setSaving(false);
    }
  }

  if (!delivery) return error ? <p className="feedback-inline" role="alert">{error}</p> : <p className="muted" role="status">正在读取发布文案和素材。</p>;

  return <section aria-label={`${delivery.platformLabel}人工发布`} className="form-stack">
    <div className="field">
      <strong>{delivery.platformLabel} · {delivery.accountName}</strong>
      <label className="field">
        <span>发布文案</span>
        <textarea rows={4} readOnly ref={copyField} value={delivery.copy} />
      </label>
    </div>
    <div className="form-actions">
      <button className="button button-outline button-compact" type="button" disabled={!delivery.copy} onClick={copy}><Copy size={14} aria-hidden="true" /> 复制文案</button>
      {delivery.canDownload && <a className="button button-outline button-compact" href={api + "/package"} download><Download size={14} aria-hidden="true" /> 下载素材包</a>}
      <a className="button button-primary button-compact" href={delivery.backendUrl} target="_blank" rel="noopener noreferrer"><ExternalLink size={14} aria-hidden="true" /> 打开官方后台</a>
    </div>
    {!delivery.canDownload && <p className="muted">原件已清理或不可用，无法下载素材包。</p>}
    {delivery.canConfirm && <form className="form-stack" onSubmit={confirm}>
      <label className="field">
        <span>发布后的帖子链接</span>
        <input type="url" value={postUrl} placeholder="https://…" required maxLength={4096}
          onChange={event => setPostUrl(event.currentTarget.value)} />
        <small>在官方后台发布完成后回填。</small>
      </label>
      <details className="field">
        <summary>在后台修改过文案</summary>
        <div className="form-stack">
          {delivery.hasTitle && <label className="field"><span>实际标题</span><input value={actualTitle} maxLength={500}
            onChange={event => setActualTitle(event.currentTarget.value)} /></label>}
          <label className="field"><span>实际正文</span><textarea value={actualBody} rows={4} maxLength={120_000}
            onChange={event => setActualBody(event.currentTarget.value)} /></label>
        </div>
      </details>
      <div className="form-actions"><button className="button button-primary button-compact" type="submit" disabled={!postUrl.trim() || saving}>
        {saving ? "正在确认" : "确认已发布"}
      </button></div>
    </form>}
    {delivery.postUrl && <a className="text-link" href={delivery.postUrl} target="_blank" rel="noopener noreferrer">查看已发布帖子 <ExternalLink size={14} aria-hidden="true" /></a>}
    {feedback && <p className="muted" role="status">{feedback}</p>}
    {error && <p className="feedback feedback-error" role="alert">{error}</p>}
  </section>;
}
