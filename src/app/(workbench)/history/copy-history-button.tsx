"use client";

import { CopyPlus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function CopyHistoryButton({ contentId }: { contentId: string }) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const router = useRouter();

  async function copy() {
    if (pending) return;
    setPending(true);
    setMessage("");
    try {
      const response = await fetch(`/api/history/${contentId}/copy`, { method: "POST" });
      const result = await response.json() as { id?: string; error?: string; removedAssets?: number };
      if (!response.ok || !result.id) throw new Error(result.error ?? "复制未完成，请稍后再试。");
      if (result.removedAssets) setMessage("已复制可用素材。");
      router.push(`/contents/${result.id}`);
    } catch (error) {
      setPending(false);
      setMessage(error instanceof Error ? error.message : "复制未完成，请稍后再试。");
    }
  }

  return <>
    <button type="button" className="button button-outline button-compact" onClick={() => void copy()} disabled={pending}>
      <CopyPlus size={14} aria-hidden="true" /> {pending ? "复制中…" : "复制为新草稿"}
    </button>
    {message && <span role="status" className="small muted">{message}</span>}
  </>;
}
