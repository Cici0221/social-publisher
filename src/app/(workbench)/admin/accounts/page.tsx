import { platformKeys, platformRules } from "@/lib/platforms";
import { liveAvailability } from "@/platforms/registry";
import { accountList } from "@/server/accounts";
import { pageActor } from "@/server/auth";
import { AccountWorkbench } from "./workbench";

export default async function AccountsPage({ searchParams }: { searchParams: Promise<{ result?: string }> }) {
  await pageActor("ADMIN");
  const [accounts, { result }] = await Promise.all([accountList(), searchParams]);
  const providers = platformKeys.map(key => ({
    key, ...liveAvailability(key),
  }));
  return <div className="page-container">
    <header className="page-header"><div><p className="page-label">管理 / 平台账号</p><h1>平台账号</h1>
      <p className="muted">管理各账号的发布授权、默认文案语言和有效期。</p></div></header>
    {result === "linked" && <p className="delivery-summary">已完成账号绑定。</p>}
    {result === "failed" && <p className="delivery-errors">授权未完成。请检查官方平台权限后重试。</p>}
    <AccountWorkbench initial={accounts.map(row => ({ ...row, expiresAt: row.expiresAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString() }))} providers={providers} demo={process.env.APP_MODE === "local"} />
  </div>;
}
