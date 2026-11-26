import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { pageActor } from "@/server/auth";
import { db } from "@/server/db";
import { ResetCredentialForm } from "./reset-form";

export const metadata: Metadata = { title: "重置成员凭据" };

export default async function MemberCredentialsPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await pageActor("ADMIN");
  const { id } = await params;
  if (id === actor.id) redirect("/settings/security");
  const target = await db().user.findUnique({ where: { id, active: true }, select: { id: true, name: true, email: true } });
  if (!target) notFound();

  return (
    <div className="page-container">
      <header className="page-header">
        <div><h1>重置成员凭据</h1><p className="muted">{target.name} · {target.email}</p></div>
        <Link className="button button-outline" href="/admin/members">返回成员管理</Link>
      </header>
      <ResetCredentialForm memberId={target.id} />
    </div>
  );
}
