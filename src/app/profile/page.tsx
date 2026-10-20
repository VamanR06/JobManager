import { listProfile } from "@/lib/profile";
import ProfileEditor from "@/components/ProfileEditor";

export const dynamic = "force-dynamic";

export default function ProfilePage() {
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-8 space-y-6">
      <h1 className="text-2xl font-bold">Verified profile</h1>
      <ProfileEditor initial={listProfile()} />
    </main>
  );
}
