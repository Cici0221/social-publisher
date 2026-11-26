import type { Metadata } from "next";
import { ShieldCheck } from "lucide-react";
import { redirect } from "next/navigation";
import { currentSession, temporaryPasswordPath } from "@/server/auth";
import { Brand } from "@/ui/brand";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "登录" };

export default async function LoginPage() {
  const session = await currentSession();
  if (session) redirect(session.passwordChangeOnly ? temporaryPasswordPath : "/");

  return (
    <main className="login-page">
      <section className="login-masthead" aria-label="一键发布">
        <Brand subtitle="宣传部工作台" />
        <div className="login-editorial">
          <p className="login-product">一键发布</p>
          <p>公司社媒多平台发布系统</p>
          <span className="login-rule" aria-hidden="true" />
        </div>
      </section>
      <section className="login-area" aria-labelledby="login-title">
        <div className="login-card">
          <div className="login-symbol" aria-hidden="true"><ShieldCheck size={23} strokeWidth={1.65} /></div>
          <h1 id="login-title">登录工作台</h1>
          <p className="muted login-help">使用部门管理员提供的账号和身份验证器登录。</p>
          <LoginForm />
        </div>
      </section>
    </main>
  );
}
