import type { Metadata } from "next";
import { pageActor } from "@/server/auth";
import { PasswordChangeForm, TotpChangeForm } from "./security-forms";

export const metadata: Metadata = { title: "账号安全" };

export default async function SecurityPage() {
  await pageActor();
  return (
    <div className="page-container">
      <header className="page-header">
        <div><h1>账号安全</h1><p className="muted">修改密码或更换双重验证器。保存后，所有设备都需要重新登录。</p></div>
      </header>
      <PasswordChangeForm />
      <TotpChangeForm />
    </div>
  );
}
