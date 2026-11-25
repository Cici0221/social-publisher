import Link from "next/link";
import { notFound } from "next/navigation";
import { pageActor } from "@/server/auth";
import { AppError } from "@/server/errors";
import { publicationProgress } from "@/server/publications";
import { PublishProgress } from "./publish-progress";

export default async function ProgressPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await pageActor("ADMIN", "EDITOR");
  try {
    const initial = await publicationProgress(actor, (await params).id);
    return <div className="page-container">
      <header className="page-header"><div><p className="page-label">工作台 / 发布进度</p><h1>发布进度</h1>
        <p className="muted">{initial.title}</p></div><Link className="button button-outline" href="/history">查看发布记录</Link>
      </header>
      <PublishProgress initial={initial} />
    </div>;
  } catch (error) {
    if (error instanceof AppError && error.status === 404) notFound();
    throw error;
  }
}
