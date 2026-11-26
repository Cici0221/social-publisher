import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "一键发布", template: "%s · 一键发布" },
  description: "公司社媒多平台发布系统",
  robots: { index: false, follow: false },
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  await connection();
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
