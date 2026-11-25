import { LogOut } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { pageActor } from "@/server/auth";
import { Brand } from "@/ui/brand";
import { roleLabels } from "@/ui/identity";
import { WorkbenchNavigation } from "@/ui/workbench-navigation";

export default async function WorkbenchLayout({ children }: { children: ReactNode }) {
  const actor = await pageActor();
  const initial = Array.from(actor.name.trim())[0] ?? "员";

  return (
    <div className="workspace">
      <a className="skip-to-content" href="#workspace-main">跳到主要内容</a>
      <aside className="workspace-sidebar">
        <Link className="workspace-brand" href="/" aria-label="一键发布工作台">
          <Brand subtitle="宣传部工作台" />
        </Link>
        <WorkbenchNavigation role={actor.role} />
        <div className="workspace-identity">
          <span className="workspace-avatar" aria-hidden="true">{initial}</span>
          <div className="workspace-identity-text">
            <strong title={actor.name}>{actor.name}</strong>
            <span>{roleLabels[actor.role]}</span>
          </div>
          <form action="/api/auth/logout" method="post">
            <button className="icon-button logout-button" title="退出登录" aria-label="退出登录">
              <LogOut size={17} strokeWidth={1.8} aria-hidden="true" />
            </button>
          </form>
        </div>
      </aside>
      <main className="workspace-main" id="workspace-main" tabIndex={-1}>{children}</main>
    </div>
  );
}
