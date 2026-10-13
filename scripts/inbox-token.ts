// Prints a fresh JOBMANAGER_INBOX_TOKEN line for .env.local (or your host's env).
// Paste the same token into the iOS Shortcut's Authorization header.
import { generateInboxToken } from "../src/lib/auth";

console.log(`JOBMANAGER_INBOX_TOKEN=${generateInboxToken()}`);
