"use client";

import { useState } from "react";
import { CredentialFields, CredentialSubmit } from "@/ui/credential-fields";
import { resetCredentialAction, type ResetState } from "./actions";

export function ResetCredentialForm({ memberId }: { memberId: string }) {
  const [state, setState] = useState<ResetState>({});
  const replacement = state.replacement;

  async function reset(form: FormData) {
    setState(await resetCredentialAction(memberId, form).catch(() => ({ error: "操作未完成，请稍后再试。" })));
  }

  return (
    <section className="panel member-create" aria-labelledby="member-reset-title">
      <div>
        <h2 id="member-reset-title" className="section-title">登录凭据</h2>
        <p className="muted">重置立即生效，该成员需重新登录。请通过私下渠道交付新凭据。</p>
      </div>
      {replacement ? (
        <div className="enrollment">
          <p role="status">重置成功。离开页面后，以下凭据将无法再次查看。</p>
          <div className="enrollment-body">
            {replacement.factor === "password" ? (
              <div className="enrollment-key">
                <span>临时密码</span><code>{replacement.password}</code>
                <p>成员下次登录时必须设置新密码。</p>
              </div>
            ) : (
              <>
                {replacement.qr && <img src={replacement.qr} width={142} height={142} alt="成员的新验证器二维码" />}
                <div className="enrollment-key"><span>手动设置密钥</span><code>{replacement.secret}</code></div>
              </>
            )}
            <button className="button button-outline" type="button" onClick={() => setState({})}>关闭凭据</button>
          </div>
        </div>
      ) : (
        <form className="form-stack" action={reset}>
          <label className="field">
            <span>重置项</span>
            <select name="factor" defaultValue="" required>
              <option value="" disabled>请选择</option>
              <option value="password">密码</option>
              <option value="totp">双重验证器</option>
            </select>
          </label>
          <CredentialFields admin />
          {state.error && <p className="feedback feedback-error" role="alert">{state.error}</p>}
          <div className="form-actions"><CredentialSubmit>确认重置</CredentialSubmit></div>
        </form>
      )}
    </section>
  );
}
