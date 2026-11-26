"use server";

import { redirect } from "next/navigation";
import { currentSessionDigest, signOut } from "@/server/auth";
import { changeTemporaryPassword, newPasswordSchema } from "@/server/credentials";
import { AppError } from "@/server/errors";

type Feedback = { error?: string };

export async function changeTemporaryPasswordAction(_: Feedback, form: FormData): Promise<Feedback> {
  const password = newPasswordSchema.safeParse(form.get("newPassword"));
  if (!password.success) return { error: "新密码须为 12–128 个字符。" };
  if (password.data !== form.get("confirmPassword")) return { error: "两次输入的新密码不一致。" };

  try {
    await changeTemporaryPassword(await currentSessionDigest(), password.data);
    await signOut();
  } catch (error) {
    if (error instanceof AppError && error.status === 401) redirect("/login");
    return { error: error instanceof AppError ? error.message : "操作未完成，请稍后再试。" };
  }
  redirect("/login");
}
