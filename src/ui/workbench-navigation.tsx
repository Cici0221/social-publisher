"use client";

import { Bell, CalendarDays, ClipboardCheck, FilePenLine, History, Images, Cable, KeyRound, LayoutDashboard, ShieldCheck, UsersRound } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Role } from "@/generated/prisma/enums";

const navigation = [
  { href: "/", label: "工作台", icon: LayoutDashboard, allowed: ["ADMIN", "EDITOR", "REVIEWER"] },
  { href: "/contents", label: "内容草稿", icon: FilePenLine, allowed: ["ADMIN", "EDITOR"] },
  { href: "/assets", label: "素材库", icon: Images, allowed: ["ADMIN", "EDITOR", "REVIEWER"] },
  { href: "/calendar", label: "发布日历", icon: CalendarDays, allowed: ["ADMIN", "EDITOR"] },
  { href: "/history", label: "发布记录", icon: History, allowed: ["ADMIN", "EDITOR"] },
  { href: "/review", label: "待审核", icon: ClipboardCheck, allowed: ["REVIEWER"] },
  { href: "/notifications", label: "站内通知", icon: Bell, allowed: ["ADMIN", "EDITOR", "REVIEWER"] },
  { href: "/admin/review-settings", label: "审核设置", icon: ShieldCheck, allowed: ["ADMIN"] },
  { href: "/admin/accounts", label: "平台账号", icon: Cable, allowed: ["ADMIN"] },
  { href: "/admin/members", label: "成员管理", icon: UsersRound, allowed: ["ADMIN"] },
  { href: "/settings/security", label: "账号安全", icon: KeyRound, allowed: ["ADMIN", "EDITOR", "REVIEWER"] },
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
