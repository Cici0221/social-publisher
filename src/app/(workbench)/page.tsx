import { ArrowDownRight, ArrowRight, Radio, ShieldCheck, UsersRound } from "lucide-react";
import Link from "next/link";
import { pageActor } from "@/server/auth";
import { db } from "@/server/db";
import NewDraft from "./contents/new-draft";
import { roleLabels } from "@/ui/identity";

const purpose = {
  ADMIN: "管理团队成员、社媒账号和发布权限。",
  EDITOR: "集中整理素材和文案，并按账号跟踪发布结果。",
  REVIEWER: "查看需要审核的内容并记录处理意见。",
};

export default async function WorkbenchPage() {
  const actor = await pageActor();
  const isAdmin = actor.role === "ADMIN";
  const [preference, accounts, members, unread, pending] = await Promise.all([
    db().preference.findUnique({ where: { id: "workspace" }, select: { reviewRequired: true } }),
    db().platformAccount.count({ where: { status: "ACTIVE", OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] } }),
    isAdmin ? db().user.count({ where: { active: true } }) : Promise.resolve(null),
    db().notification.count({ where: { userId: actor.id, readAt: null } }),
    actor.role === "REVIEWER" ? db().content.count({ where: { status: "IN_REVIEW" } }) : Promise.resolve(null),
  ]);
  const requiresReview = preference?.reviewRequired ?? false;
  const date = new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "long", timeZone: "Asia/Shanghai",
  }).format(new Date());

  return (
    <div className="page-container">
      <header className="page-header">
        <div><p className="page-label">{date} · 北京时间</p><h1>工作台</h1></div>
        <div className="delivery-actions">
          <span className="identity-label">{roleLabels[actor.role]}</span>
          {actor.role === "REVIEWER" ? <Link className="button button-primary" href="/review">查看待审核</Link> : <NewDraft />}
        </div>
      </header>

      <section className="workspace-intro" aria-labelledby="welcome-title">
        <div>
          <p className="intro-label">宣传部 · 社媒发布</p>
          <h2 id="welcome-title">你好，{actor.name}</h2>
          <p>{purpose[actor.role]}</p>
        </div>
        <ArrowDownRight className="intro-arrow" size={78} strokeWidth={0.95} aria-hidden="true" />
      </section>

      <section className="workspace-summary" aria-labelledby="workspace-status">
        <h2 className="section-title" id="workspace-status">工作区状态</h2>
        <dl className="summary-grid">
          <div className="summary-card">
            <dt><Radio size={18} aria-hidden="true" /> 可用平台账号</dt>
            <dd>{accounts}<span> 个</span></dd>
          </div>
          <div className="summary-card">
            <dt><ShieldCheck size={18} aria-hidden="true" /> 发布审核</dt>
            <dd className="summary-word">{requiresReview ? "已开启" : "已关闭"}</dd>
            {isAdmin && <Link className="text-link" href="/admin/review-settings">管理审核</Link>}
          </div>
          <div className="summary-card">
            <dt>未读通知</dt><dd>{unread}<span> 条</span></dd>
            <Link className="text-link" href="/notifications">打开收件箱</Link>
          </div>
          {pending !== null && <div className="summary-card">
            <dt>待审核内容</dt><dd>{pending}<span> 条</span></dd>
            <Link className="text-link" href="/review">进入审核</Link>
          </div>}
          {members !== null && (
            <div className="summary-card">
              <dt><UsersRound size={18} aria-hidden="true" /> 启用的成员</dt>
              <dd>{members}<span> 人</span></dd>
              <Link className="text-link" href="/admin/members">管理成员 <ArrowRight size={15} aria-hidden="true" /></Link>
            </div>
          )}
        </dl>
      </section>
    </div>
  );
}
