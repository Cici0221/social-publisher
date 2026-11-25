"use client";

import { FilePenLine, Images, LayoutDashboard, UsersRound } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Role } from "@/generated/prisma/enums";

const navigation = [
  { href: "/", label: "工作台", icon: LayoutDashboard, allowed: ["ADMIN", "EDITOR", "REVIEWER"] },
  { href: "/contents", label: "内容草稿", icon: FilePenLine, allowed: ["ADMIN", "EDITOR"] },
  { href: "/assets", label: "素材库", icon: Images, allowed: ["ADMIN", "EDITOR", "REVIEWER"] },
  { href: "/admin/members", label: "成员管理", icon: UsersRound, allowed: ["ADMIN"] },
];

export function WorkbenchNavigation({ role }: { role: Role }) {
  const pathname = usePathname();

  return (
    <nav className="workspace-navigation" aria-label="主导航">
      {navigation.filter(item => item.allowed.includes(role)).map(({ href, label, icon: Icon }) => {
        const active = pathname === href || (href !== "/" && pathname.startsWith(href + "/"));
        return (
          <Link className="nav-link" key={href} href={href} aria-current={active ? "page" : undefined}>
            <Icon size={18} strokeWidth={1.7} aria-hidden="true" />
            <span>{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
