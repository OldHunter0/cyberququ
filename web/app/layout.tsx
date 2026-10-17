import "./globals.css";
import type { Metadata, Viewport } from "next";

export const metadata: Metadata = { title: "赛博斗蛐蛐 · Prompt Arena", description: "一句话捏一只 AI 蛐蛐，链上开打" };
export const viewport: Viewport = { width: "device-width", initialScale: 1, maximumScale: 1, themeColor: "#0b0b14" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
