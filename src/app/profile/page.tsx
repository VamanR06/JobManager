import { listProfile } from "@/lib/profile";
import { listExperiences } from "@/lib/experience";
import { listAnswers } from "@/lib/apply/answers";
import ProfileEditor from "@/components/ProfileEditor";
import ExperienceEditor from "@/components/ExperienceEditor";
import AnswersEditor from "@/components/AnswersEditor";

export const dynamic = "force-dynamic";

export default function ProfilePage() {
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-8 space-y-6">
      <h1 className="text-2xl font-bold">Verified profile</h1>
      <ProfileEditor initial={listProfile()} />
      <h2 className="border-t border-zinc-200 pt-6 text-xl font-bold dark:border-zinc-800">Work experience</h2>
      <ExperienceEditor initial={listExperiences()} />
      <h2 className="border-t border-zinc-200 pt-6 text-xl font-bold dark:border-zinc-800">Saved answers</h2>
      <AnswersEditor initial={listAnswers()} />
    </main>
  );
}
