"use client";

import { Check, Settings2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import styles from "./review-settings.module.css";

export function ReviewSettingsForm({ required, reviewerCount, pendingCount }: {
  required: boolean; reviewerCount: number; pendingCount: number;
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(required);
  const [confirmed, setConfirmed] = useState(required);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || enabled === confirmed) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/admin/review-settings", {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ required: enabled }),
      });
      const value: { required?: boolean; error?: string } = await response.json().catch(() => ({}));
      if (!response.ok || typeof value.required !== "boolean") throw new Error(value.error ?? "审核设置保存失败。");
      setConfirmed(value.required);
      setEnabled(value.required);
      setMessage(value.required ? "审核已开启。" : "审核已关闭。");
      router.refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "审核设置保存失败。");
    } finally {
      setSaving(false);
    }
  }

  return <form className={`panel ${styles.settings}`} onSubmit={save} aria-label="审核设置">
    <div className={styles.heading}>
      <Settings2 size={21} aria-hidden="true" /><h2 className="section-title">发布前审核</h2>
      <span className={confirmed ? "state-tag" : styles.inactive}>{confirmed ? "已开启" : "已关闭"}</span>
    </div>
    <div className={styles.body}>
      <label className={styles.option}>
        <span><strong>新内容必须经过审核</strong><small>开启后，新提交由审核人先核对。已经在审核队列中的内容仍按原流程处理。</small></span>
        <input type="checkbox" role="switch" checked={enabled} disabled={saving}
          onChange={event => { setEnabled(event.currentTarget.checked); setMessage(""); setError(""); }} />
      </label>
      <div className={styles.summary}>
        <span>有效审核人 <strong>{reviewerCount}</strong></span>
        <span>待审核内容 <strong>{pendingCount}</strong></span>
      </div>
      {enabled && reviewerCount === 0 && <p className={styles.error} role="status">当前没有审核人。开启后，内容将等待有审核权限的成员处理。</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}
      <div className={styles.actions}>
        <p role="status">{message}</p>
        <button className="button button-primary" disabled={saving || enabled === confirmed}>
          <Check size={17} aria-hidden="true" />{saving ? "正在保存…" : "保存设置"}</button>
      </div>
    </div>
  </form>;
}
