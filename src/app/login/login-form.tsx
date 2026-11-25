"use client";

import { ArrowRight } from "lucide-react";
import { useState, type FormEvent } from "react";

export function LoginForm() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  async function logIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(undefined);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: form.get("email"), password: form.get("password"), code: form.get("code"),
        }),
      });

      if (response.ok) {
        window.location.replace("/");
        return;
      }

      const result = await response.json().catch(() => null) as { error?: string } | null;
      setError(result?.error ?? "登录未完成，请稍后再试。");
    } catch {
      setError("暂时无法连接系统，请稍后再试。");
    }
    setPending(false);
  }

  return (
    <form className="form-stack login-form" method="post" action="/api/auth/login" onSubmit={logIn}>
      <label className="field">
        <span>工作邮箱</span>
        <input name="email" type="email" placeholder="name@company.com" autoComplete="username" maxLength={254} required />
      </label>
      <label className="field">
        <span>密码</span>
        <input name="password" type="password" autoComplete="current-password" maxLength={128} required />
      </label>
      <label className="field">
        <span>动态验证码</span>
        <input name="code" type="text" inputMode="numeric" autoComplete="one-time-code"
          maxLength={6} pattern="[0-9]{6}" placeholder="6 位数字" aria-describedby="code-help" required />
        <small id="code-help">输入身份验证器当前显示的 6 位数字。</small>
      </label>
      {error && <p className="feedback feedback-error" role="alert">{error}</p>}
      <button type="submit" className="button button-primary login-submit" disabled={pending}>
        {pending ? "正在登录…" : "登录"} <ArrowRight size={17} aria-hidden="true" />
      </button>
    </form>
  );
}
