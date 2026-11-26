"use server";

import QRCode from "qrcode";
import { z } from "zod";
import { requireActor } from "@/server/auth";
import { credentialResetSchema, resetMemberCredential } from "@/server/credentials";
import { AppError } from "@/server/errors";

export type ResetState = {
  error?: string;
  replacement?: { factor: "password"; password: string } | { factor: "totp"; secret: string; qr?: string };
};

export async function resetCredentialAction(targetId: string, form: FormData): Promise<ResetState> {
  try {
    const actor = await requireActor("ADMIN");
    const id = z.uuid().safeParse(targetId);
    if (!id.success) return { error: "成员不存在。" };
    const input = credentialResetSchema.safeParse({ factor: form.get("factor"), password: form.get("password"), code: form.get("code") });
    if (!input.success) return { error: "请选择重置项并填写你的管理员密码和 6 位验证码。" };
    const replacement = await resetMemberCredential(actor.id, id.data, input.data);
    if (replacement.factor === "password") return { replacement };
    const qr = await QRCode.toDataURL(replacement.uri, { errorCorrectionLevel: "M", margin: 2 }).catch(() => undefined);
    return { replacement: { factor: "totp", secret: replacement.secret, qr } };
  } catch (error) {
    return { error: error instanceof AppError ? error.message : "操作未完成，请稍后再试。" };
  }
}
