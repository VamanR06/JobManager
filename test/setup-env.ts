// Imported first by every test file (each runs in its own process): points the
// DB layer at a throwaway data dir before anything opens it.
import fs from "fs";
import os from "os";
import path from "path";

process.env.JOBMANAGER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "jm-test-"));
process.env.JOBMANAGER_ROLE = "test";
process.env.JOBMANAGER_WORK_ROOT = path.join(process.env.JOBMANAGER_DATA_DIR, "work");
