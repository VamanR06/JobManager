// Child process for the concurrency test: claims and completes tasks until none are left.
process.env.JOBMANAGER_ROLE = "test";
import { claimTask, completeTask } from "../../src/lib/queue";

const owner = process.argv[2];
const resources = process.argv[3] ? [process.argv[3] as "network"] : undefined;
const claimed: number[] = [];
let idle = 0;
while (idle < 50) {
  const t = claimTask(owner, 60_000, resources);
  if (!t) {
    idle++;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    continue;
  }
  idle = 0;
  claimed.push(t.id);
  completeTask(t.id, owner, undefined, { state: "needs_input", detail: "done" });
}
process.stdout.write(JSON.stringify(claimed));
