import type { Role } from "@/generated/prisma/enums";

export const roleLabels: Record<Role, string> = {
  ADMIN: "管理员",
  EDITOR: "编辑",
  REVIEWER: "审核人",
};

export const roles = Object.keys(roleLabels) as Role[];
