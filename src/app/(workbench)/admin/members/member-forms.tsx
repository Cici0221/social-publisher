"use client";

import { UserRoundPlus, X } from "lucide-react";
import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import type { Role } from "@/generated/prisma/enums";
import { roleLabels, roles } from "@/ui/identity";
import { createMemberAction, editMemberAction, type CreateState } from "./actions";

export type MemberRow = { id: string; name: string; email: string; role: Role; active: boolean };

function RoleOptions() {
  return roles.map(role => <option key={role} value={role}>{roleLabels[role]}</option>);
}

function AddMemberButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="button button-primary" disabled={pending}>
      {pending ? "正在添加…" : "添加成员"}
    </button>
  );
}

export function NewMemberForm() {
  const [state, setState] = useState<CreateState>({});
  const enrollment = state.enrollment;

  async function addMember(form: FormData) {
    setState({});
    setState(await createMemberAction(form).catch(() => ({ error: "操作未完成，请稍后再试。" })));
  }

  return (
    <section className="panel member-create" aria-labelledby="member-create-title">
      <div>
        <span className="section-icon" aria-hidden="true"><UserRoundPlus size={20} strokeWidth={1.7} /></span>
        <h2 className="section-title" id="member-create-title">添加成员</h2>
        <p className="muted">为同事分配角色，并设置首次登录凭据。</p>
      </div>
      <div>
        <form action={addMember} className="form-stack">
          <div className="form-grid">
            <label className="field">
              <span>姓名</span>
              <input name="name" autoComplete="off" maxLength={80} required />
            </label>
            <label className="field">
              <span>工作邮箱</span>
              <input type="email" name="email" autoComplete="off" maxLength={254} required />
            </label>
            <label className="field">
              <span>角色</span>
              <select name="role" defaultValue="EDITOR"><RoleOptions /></select>
            </label>
            <label className="field">
              <span>初始密码</span>
              <input type="password" name="password" autoComplete="new-password" minLength={12} maxLength={128}
                aria-describedby="member-password-hint" required />
              <small id="member-password-hint">至少 12 个字符。</small>
            </label>
          </div>
          {state.error && <p className="feedback feedback-error" role="alert">{state.error}</p>}
          <div className="form-actions">
            <AddMemberButton />
            {state.message && !enrollment && <span className="small muted" role="status">{state.message}</span>}
          </div>
        </form>
        {enrollment && (
          <aside className="enrollment" aria-labelledby="enrollment-title">
            <div className="enrollment-header">
              <h3 id="enrollment-title">设置双重验证</h3>
              <button type="button" className="icon-button" aria-label="关闭设置凭据"
                onClick={() => setState({ message: state.message })}>
                <X size={18} aria-hidden="true" />
              </button>
            </div>
            <p role="status">成员需要用身份验证器扫描二维码，或手动输入密钥。凭据仅在本次添加后显示，请私下交给对应成员。</p>
            <div className="enrollment-body">
              {enrollment.qr && (
                // The QR is a sensitive data URL generated for the current admin session.
                // eslint-disable-next-line @next/next/no-img-element
                <img src={enrollment.qr} width={142} height={142} alt="双重验证设置二维码" />
              )}
              <div className="enrollment-key"><span>手动设置密钥</span><code>{enrollment.secret}</code></div>
            </div>
          </aside>
        )}
      </div>
    </section>
  );
}

export function MemberSettings({ member, self }: { member: MemberRow; self: boolean }) {
  const [state, action, pending] = useActionState(editMemberAction, {});
  const formId = `member-${member.id}`;

  if (self) {
    return (
      <>
        <td>{roleLabels[member.role]}</td>
        <td><span className="state-tag state-active">已启用</span></td>
        <td className="muted small">当前账号</td>
      </>
    );
  }

  return (
    <>
      <td>
        <select form={formId} name="role" aria-label={`${member.name}的角色`} defaultValue={member.role}>
          <RoleOptions />
        </select>
      </td>
      <td>
        <select form={formId} name="active" aria-label={`${member.name}的状态`}
          defaultValue={member.active ? "enabled" : "disabled"}>
          <option value="enabled">已启用</option>
          <option value="disabled">已停用</option>
        </select>
      </td>
      <td>
        <form id={formId} action={action} className="member-row-form">
          <input type="hidden" name="id" value={member.id} />
          <button className="button button-outline button-compact" type="submit" disabled={pending}
            aria-label={`保存${member.name}的设置`}>{pending ? "保存中…" : "保存"}</button>
          {state.error && <span className="small feedback-inline" role="alert">{state.error}</span>}
          {state.message && <span className="small muted" role="status">{state.message}</span>}
        </form>
      </td>
    </>
  );
}
