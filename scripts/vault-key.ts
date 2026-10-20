// Prints a fresh JOBMANAGER_VAULT_KEY line for .env.local. It encrypts the
// job-portal passwords the ChatGPT browser tools create; changing it makes the
// saved ones unreadable.
import { generateVaultKey } from "../src/lib/apply/vault";

console.log(`JOBMANAGER_VAULT_KEY=${generateVaultKey()}`);
