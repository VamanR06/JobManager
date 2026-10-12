// Prints a JOBMANAGER_PASSWORD_HASH line for .env.local (or your host's env).
//   npm run auth:hash            → prompts for the password (not echoed)
//   npm run auth:hash -- <pw>    → hashes the argument (ends up in shell history)
import readline from "readline";
import { hashPassword } from "../src/lib/auth";

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  // Swallow keystroke echo while typing the password.
  (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s) => {
    if (s.startsWith(question)) process.stdout.write(s);
  };
  const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
  rl.close();
  process.stdout.write("\n");
  return answer;
}

async function main() {
  let password = process.argv[2];
  if (!password) {
    password = await prompt("Password: ");
    if ((await prompt("Again: ")) !== password) {
      console.error("Passwords don't match.");
      process.exit(1);
    }
  }
  if (password.length < 8) {
    console.error("Use at least 8 characters.");
    process.exit(1);
  }
  console.log(`JOBMANAGER_PASSWORD_HASH=${hashPassword(password)}`);
}

main();
