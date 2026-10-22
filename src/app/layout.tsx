import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import NavTabs from "@/components/NavTabs";
import { authEnabled } from "@/lib/auth";
import { APP_VERSION } from "@/lib/version";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "JobManager",
  description: "Personal job application tracker",
  // Backs up the X-Robots-Tag header in case a reverse proxy strips it.
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <NavTabs showSignOut={authEnabled()} />
        {children}
        <footer className="px-6 py-3 text-right text-xs text-zinc-400">JobManager v{APP_VERSION}</footer>
      </body>
    </html>
  );
}
