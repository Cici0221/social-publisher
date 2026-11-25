"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function ReadNotificationButton({ id }: { id?: string }) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();

  async function mark() {
    if (working) return;
    setWorking(true);
    setError("");
    try {
      const response = await fetch("/api/notifications/read", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(id ? { id } : { all: true }),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(result?.error ?? "无法标记通知，请稍后再试。");
      }
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法标记通知，请稍后再试。");
    } finally {
      setWorking(false);
    }
  }

  return <span>
    <button type="button" className="button button-outline button-compact" onClick={() => void mark()} disabled={working}>
      {working ? "处理中…" : id ? "标为已读" : "全部标为已读"}
    </button>
    {error && <span className="feedback-inline small" role="alert"> {error}</span>}
  </span>;
}
