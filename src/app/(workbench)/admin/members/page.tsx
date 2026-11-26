import type { Metadata } from "next";
import { pageActor } from "@/server/auth";
import { db } from "@/server/db";
import { MemberSettings, NewMemberForm } from "./member-forms";

export const metadata: Metadata = { title: "成员管理" };

export default async function MembersPage() {
  const actor = await pageActor("ADMIN");
  const members = await db().user.findMany({
    select: { id: true, name: true, email: true, role: true, active: true },
    orderBy: [{ active: "desc" }, { createdAt: "asc" }],
  });

  return (
    <div className="page-container">
      <header className="page-header">
        <div><h1>成员管理</h1><p className="muted">停用成员会取消其待审核、排队及定时任务。已发往平台的任务会继续核对结果。</p></div>
      </header>

      <NewMemberForm />

      <section className="panel members-panel" aria-labelledby="members-list-title">
        <div className="panel-header">
          <h2 className="section-title" id="members-list-title">团队成员</h2>
          <span className="muted small">{members.length} 人</span>
        </div>
        <div className="table-scroll" role="region" aria-labelledby="members-list-title" tabIndex={0}>
          <table className="data-table members-table">
            <thead><tr><th scope="col">姓名与邮箱</th><th scope="col">角色</th><th scope="col">状态</th><th scope="col">操作</th></tr></thead>
            <tbody>
              {members.map(member => (
                <tr key={member.id}>
                  <th scope="row">
                    <div className="person">
                      <span className="person-avatar" aria-hidden="true">{Array.from(member.name)[0] ?? "员"}</span>
                      <span><strong>{member.name}</strong><small>{member.email}</small></span>
                    </div>
                  </th>
                  <MemberSettings member={member} self={member.id === actor.id} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
