"use server";

import QRCode from "qrcode";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireActor } from "@/server/auth";
import { AppError } from "@/server/errors";
import { createMember, editMember, memberSchema } from "@/server/team";

type Feedback = { message?: string; error?: string };
type Enrollment = { secret: string; qr?: string };
export type CreateState = Feedback & { enrollment?: Enrollment };

function errorMessage(error: unknown): string {
  if (error instanceof AppError) return error.message;
  if (typeof error === "object" && error && "code" in error && error.code === "P2002") {
    return "该邮箱已登记。";
  }
  return "操作未完成，请稍后再试。";
}

const memberEditSchema = z.object({
  id: z.uuid(),
  role: memberSchema.shape.role,
  active: z.enum(["enabled", "disabled"]).transform(value => value === "enabled"),
});

export async function createMemberAction(form: FormData): Promise<CreateState> {
  try {
    const actor = await requireActor("ADMIN");
    const parsed = memberSchema.safeParse({
      email: form.get("email"),
      name: form.get("name"),
      role: form.get("role"),
      password: form.get("password"),
    });

    if (!parsed.success) {
      return { error: "请填写有效的邮箱、姓名和角色，密码长度须为 12–128 个字符。" };
    }

    const setup = await createMember(actor.id, parsed.data);
    const qr = await QRCode.toDataURL(setup.uri, { errorCorrectionLevel: "M", margin: 2 }).catch(() => undefined);
    revalidatePath("/admin/members");

    return {
      message: "已添加成员。",
      enrollment: { secret: setup.secret, qr },
    };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

export async function editMemberAction(_: Feedback, form: FormData): Promise<Feedback> {
  try {
    const actor = await requireActor("ADMIN");
    const parsed = memberEditSchema.safeParse({
      id: form.get("id"), role: form.get("role"), active: form.get("active"),
    });
    if (!parsed.success) return { error: "请选择有效的成员角色和状态。" };

    await editMember(actor.id, parsed.data.id, parsed.data.role, parsed.data.active);
    revalidatePath("/admin/members");

    return { message: "已保存" };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}
