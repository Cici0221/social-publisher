import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { currentSession } from "@/server/auth";
import { TemporaryPasswordForm } from "./password-form";

export const metadata: Metadata = { title: "修改临时密码" };

export default async function TemporaryPasswordPage() {
  const session = await currentSession();
  if (!session) redirect("/login");
  if (!session.passwordChangeOnly) redirect("/");

  return (
    <main className="login-area">
      <section className="login-card" aria-labelledby="change-temporary-password-title">
        <h1 id="change-temporary-password-title">修改临时密码</h1>
        <p className="muted login-help">保存后，使用新密码和下一组动态验证码登录工作台。</p>
        <TemporaryPasswordForm />
        <form className="form-actions" action="/api/auth/logout" method="post">
          <button type="submit" className="button button-outline">退出登录</button>
        </form>
      </section>
    </main>
  );
}
