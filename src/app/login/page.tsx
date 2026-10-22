import { redirect } from "next/navigation";
import KeepFragment from "@/components/KeepFragment";
import { authEnabled, safeNextPath } from "@/lib/auth";

export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  invalid: "Wrong password.",
  locked: "Too many attempts. Try again in 15 minutes.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  const target = safeNextPath(next);
  if (!authEnabled()) redirect(target);

  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-6 py-16">
      <form method="post" action="/api/auth/login" className="space-y-4">
        <h1 className="text-2xl font-bold">Sign in</h1>
        <input type="hidden" id="login-next" name="next" defaultValue={target} />
        <KeepFragment inputId="login-next" />
        <input
          type="password"
          name="password"
          autoComplete="current-password"
          autoFocus
          required
          placeholder="Password"
          className="w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-sm dark:border-zinc-700"
        />
        {error && ERRORS[error] && <p className="text-sm text-red-600 dark:text-red-400">{ERRORS[error]}</p>}
        <button
          type="submit"
          className="w-full rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          Sign in
        </button>
      </form>
    </main>
  );
}
