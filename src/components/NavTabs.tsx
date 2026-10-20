"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/", label: "Applications" },
  { href: "/resumes", label: "Resumes" },
  { href: "/cover-letters", label: "Cover Letters" },
  { href: "/profile", label: "Profile" },
];

export default function NavTabs({ showSignOut = false }: { showSignOut?: boolean }) {
  const pathname = usePathname();
  if (pathname === "/login") return null;
  return (
    <nav className="border-b border-zinc-200 dark:border-zinc-800">
      <div className="mx-auto flex w-full max-w-5xl items-center gap-1 px-6">
        <span className="mr-4 py-3 text-sm font-bold">JobManager</span>
        {TABS.map((tab) => {
          const active = tab.href === "/" ? pathname === "/" || pathname.startsWith("/jobs") : pathname.startsWith(tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={`border-b-2 px-3 py-3 text-sm ${
                active
                  ? "border-blue-600 font-medium text-blue-600 dark:text-blue-400"
                  : "border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
              }`}
            >
              {tab.label}
            </Link>
          );
        })}
        {showSignOut && (
          <form method="post" action="/api/auth/logout" className="ml-auto">
            <button type="submit" className="px-3 py-3 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
              Sign out
            </button>
          </form>
        )}
      </div>
    </nav>
  );
}
