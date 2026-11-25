"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Plus } from "lucide-react";

export default function NewDraftButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function create() {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/drafts", { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      router.push(`/contents/${data.id}`);
      router.refresh();
    } catch (error) {
      setError(error instanceof Error && error.message ? error.message : "草稿创建失败，请重试。");
      setLoading(false);
    }
  }

  return <div>
    <button className="button button-primary" type="button" disabled={loading} onClick={create}>
      <Plus size={17} aria-hidden="true" /> {loading ? "正在创建" : "新建发布"}
    </button>
    {error && <p className="feedback-inline" role="alert">{error}</p>}
  </div>;
}
