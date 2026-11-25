import Link from "next/link";
import { notFound } from "next/navigation";
import { pageActor } from "@/server/auth";
import { AppError } from "@/server/errors";
import { publicationPlan } from "@/server/publications";
import { PublishReview } from "./publish-review";

export default async function PublishPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await pageActor("ADMIN", "EDITOR");
  const { id } = await params;
  try {
    const plan = await publicationPlan(actor, id);
    return <div className="page-container">
      <header className="page-header"><div><p className="page-label">内容草稿 / 提交</p><h1>核对发布清单</h1>
        <p className="muted">{plan.title}</p></div>
        <Link className="button button-outline" href={`/contents/${id}`}>继续编辑</Link>
      </header>
      <PublishReview key={plan.revision} plan={plan} />
    </div>;
  } catch (error) {
    if (error instanceof AppError && error.status === 404) notFound();
    throw error;
  }
}
