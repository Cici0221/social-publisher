"use client";

import { useActionState } from "react";
import { CredentialSubmit, NewPasswordFields } from "@/ui/credential-fields";
import { changeTemporaryPasswordAction } from "./actions";

export function TemporaryPasswordForm() {
  const [state, action] = useActionState(changeTemporaryPasswordAction, {});
  return (
    <form className="form-stack" action={action}>
      <NewPasswordFields />
      {state.error && <p className="feedback feedback-error" role="alert">{state.error}</p>}
      <div className="form-actions"><CredentialSubmit>保存新密码</CredentialSubmit></div>
    </form>
  );
}
