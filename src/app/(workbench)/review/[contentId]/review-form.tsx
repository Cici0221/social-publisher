"use client";

import { Check, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import styles from "../review.module.css";

export function ReviewForm({ contentId, revision, canApprove }: { contentId: string; revision: number; canApprove: boolean }) {
  const router = useRouter();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (working || stale) return;
    const button = (event.nativeEvent as SubmitEvent).submitter;
    const decision = button instanceof HTMLButtonElement ? button.value : undefined;
    if (decision !== "approve" && decision !== "return") return;
    if (decision === "approve" && !canApprove) return;
    const note = String(new FormData(event.currentTarget).get("note") ?? "").trim();
    if (!note) { setError("请填写审核意见。"); return; }
    setWorking(true);
    setError("");
    try {
      const response = await fetch(`/api/review/${contentId}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, note, revision }),
      });
      if (!response.ok) {
        const body: { error?: string } = await response.json().catch(() => ({}));
        if (response.status === 409) setStale(true);
        throw new Error(body.error ?? "审核提交未完成，请重试。");
      }
      router.replace("/review");
      router.refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "审核提交未完成，请重试。");
      setWorking(false);
    }
  }

  return <form className={`panel ${styles.form}`} aria-label="审核处理" onSubmit={submit}>
    <h2 className="section-title">审核意见</h2>
    <label className="field" htmlFor="review-note"><span>意见（必填）</span>
      <textarea id="review-note" name="note" rows={4} required maxLength={2000}
        placeholder="填写通过依据，或具体说明需要修改的地方。" /></label>
    {!canApprove && <p className="muted small">该提交的快照信息不完整，可以填写意见并退回。</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    {stale ? <Link href="/review" className="text-link">返回待审核列表</Link> :
      <div className={styles.formButtons}>
        <button className="button button-outline" name="decision" value="return" disabled={working}>
          <RotateCcw size={16} aria-hidden="true" />退回修改</button>
        <button className="button button-primary" name="decision" value="approve" disabled={working || !canApprove}>
          <Check size={16} aria-hidden="true" />审核通过</button>
      </div>}
  </form>;
}
