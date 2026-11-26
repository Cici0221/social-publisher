"use server";

import QRCode from "qrcode";
import { redirect } from "next/navigation";
import { requireActor, signOut } from "@/server/auth";
import { changePassword, changeTotp, passwordChangeSchema, startTotpChange, totpChangeSchema } from "@/server/credentials";
import { AppError } from "@/server/errors";

type Feedback = { error?: string };
export type EnrollmentState = Feedback & { enrollment?: { challenge: string; secret: string; qr?: string } };

function failure(error: unknown): Feedback {
  return { error: error instanceof AppError ? error.message : "操作未完成，请稍后再试。" };
}

export async function changePasswordAction(_: Feedback, form: FormData): Promise<Feedback> {
  try {
    const actor = await requireActor();
    const input = passwordChangeSchema.safeParse({ password: form.get("password"), code: form.get("code"), newPassword: form.get("newPassword") });
    if (!input.success) return { error: "请填写当前密码和 6 位验证码。新密码须为 12–128 个字符。" };
    if (input.data.newPassword !== form.get("confirmPassword")) return { error: "两次输入的新密码不一致。" };
    await changePassword(actor.id, input.data);
    await signOut();
  } catch (error) {
    return failure(error);
  }
  redirect("/login");
}

export async function startTotpChangeAction(): Promise<EnrollmentState> {
  try {
    const actor = await requireActor();
    const { challenge, secret, uri } = await startTotpChange(actor.id);
    const qr = await QRCode.toDataURL(uri, { errorCorrectionLevel: "M", margin: 2 }).catch(() => undefined);
    return { enrollment: { challenge, secret, qr } };
  } catch (error) {
    return failure(error);
  }
}

export async function changeTotpAction(_: Feedback, form: FormData): Promise<Feedback> {
  try {
    const actor = await requireActor();
    const input = totpChangeSchema.safeParse({
      password: form.get("password"), code: form.get("code"), challenge: form.get("challenge"), newCode: form.get("newCode"),
    });
    if (!input.success) return { error: "请填写当前密码和两个验证器各自生成的 6 位验证码。" };
    await changeTotp(actor.id, input.data);
    await signOut();
  } catch (error) {
    return failure(error);
  }
  redirect("/login");
}
