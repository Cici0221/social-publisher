"use client";

import { useActionState, useState } from "react";
import { CredentialFields, CredentialSubmit, NewPasswordFields } from "@/ui/credential-fields";
import { changePasswordAction, changeTotpAction, startTotpChangeAction, type EnrollmentState } from "./actions";

export function PasswordChangeForm() {
  const [state, action] = useActionState(changePasswordAction, {});
  return (
    <section className="panel member-create" aria-labelledby="password-change-title">
      <h2 className="section-title" id="password-change-title">修改密码</h2>
      <form action={action} className="form-stack">
        <CredentialFields />
        <NewPasswordFields />
        {state.error && <p className="feedback feedback-error" role="alert">{state.error}</p>}
        <div className="form-actions"><CredentialSubmit>保存新密码</CredentialSubmit></div>
      </form>
    </section>
  );
}

function ConfirmTotpForm({ enrollment, onCancel }: { enrollment: NonNullable<EnrollmentState["enrollment"]>; onCancel: () => void }) {
  const [state, action, pending] = useActionState(changeTotpAction, {});
  return (
    <form className="form-stack" action={action}>
      <input type="hidden" name="challenge" value={enrollment.challenge} />
      <div className="enrollment">
        <p>用新的验证器扫描二维码或输入密钥。请在 10 分钟内验证。</p>
        <div className="enrollment-body">
          {enrollment.qr && <img src={enrollment.qr} width={142} height={142} alt="新验证器设置二维码" />}
          <div className="enrollment-key"><span>手动设置密钥</span><code>{enrollment.secret}</code></div>
        </div>
      </div>
      <CredentialFields />
      <label className="field">
        <span>新验证器的验证码</span>
        <input name="newCode" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required />
      </label>
      {state.error && <p className="feedback feedback-error" role="alert">{state.error}</p>}
      <div className="form-actions">
        <CredentialSubmit>启用新验证器</CredentialSubmit>
        <button className="button button-outline" type="button" disabled={pending} onClick={onCancel}>取消更换</button>
      </div>
    </form>
  );
}

export function TotpChangeForm() {
  const [state, setState] = useState<EnrollmentState>({});
  const enrollment = state.enrollment;
  async function initialize() {
    setState(await startTotpChangeAction().catch(() => ({ error: "操作未完成，请稍后再试。" })));
  }
  return (
    <section className="panel member-create" aria-labelledby="totp-change-title">
      <div>
        <h2 className="section-title" id="totp-change-title">更换双重验证器</h2>
        <p className="muted">保存时需要同时验证当前验证器和新验证器。登录时请使用下一个验证码。</p>
      </div>
      {enrollment ? (
        <ConfirmTotpForm enrollment={enrollment} onCancel={() => setState({})} />
      ) : (
        <form className="form-stack" action={initialize}>
          {state.error && <p className="feedback feedback-error" role="alert">{state.error}</p>}
          <div className="form-actions"><CredentialSubmit>设置新验证器</CredentialSubmit></div>
        </form>
      )}
    </section>
  );
}
