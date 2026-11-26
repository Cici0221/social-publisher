import { useFormStatus } from "react-dom";

export function CredentialFields({ admin = false }: { admin?: boolean }) {
  return (
    <div className="form-grid">
      <label className="field">
        <span>{admin ? "你的管理员密码" : "当前密码"}</span>
        <input type="password" name="password" autoComplete="current-password" maxLength={128} required />
      </label>
      <label className="field">
        <span>{admin ? "你的管理员验证码" : "当前验证器的验证码"}</span>
        <input name="code" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required />
        <small>请输入 6 位尚未使用的动态验证码。</small>
      </label>
    </div>
  );
}

export function CredentialSubmit({ children }: { children: string }) {
  const { pending } = useFormStatus();
  return <button type="submit" className="button button-primary" disabled={pending}>{pending ? "正在处理…" : children}</button>;
}

export function NewPasswordFields() {
  return (
    <div className="form-grid">
      <label className="field">
        <span>新密码</span>
        <input type="password" name="newPassword" autoComplete="new-password" minLength={12} maxLength={128} required />
        <small>至少 12 个字符。</small>
      </label>
      <label className="field">
        <span>确认新密码</span>
        <input type="password" name="confirmPassword" autoComplete="new-password" minLength={12} maxLength={128} required />
      </label>
    </div>
  );
}
