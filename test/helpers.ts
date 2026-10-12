import fs from "fs";
import os from "os";
import path from "path";
import type { PreflightResult } from "../src/lib/codex/preflight";
import type { CodexConfig } from "../src/lib/codex/config";

export const FAKE_CODEX = path.join(__dirname, "fixtures", "fake-codex.mjs");

/** A plugin folder shaped like the real Resume Builder bundle. */
export function fakePreflight(): PreflightResult {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jm-plugin-"));
  const skillDir = path.join(root, "skills", "instructions");
  for (const f of ["SKILL.md", "lookup/knowledge-index.json", "references/tailored_resume_builder_spec.md", "references/Example.tex", "references/Vaman_Rajagopal_Resume_Content_Bank.zip"]) {
    fs.mkdirSync(path.dirname(path.join(skillDir, f)), { recursive: true });
    fs.writeFileSync(path.join(skillDir, f), "x");
  }
  return {
    ok: true, engine: "codex", checkedAt: new Date().toISOString(), cliVersion: "codex-cli fake", loggedIn: true,
    plugin: { ref: "gpt-fake@test-market", version: "0.0.1", root, skillDir, resourceHash: "fakehash", files: [] },
    tools: {}, blockers: [],
  };
}

export function fakeConfig(overrides: Partial<CodexConfig> = {}): CodexConfig {
  return {
    bin: FAKE_CODEX, pluginRef: "gpt-fake@test-market", pluginName: "gpt-fake", marketplace: "test-market",
    codexHome: os.tmpdir(), timeoutMs: 60_000, repairLimit: 3, model: null, reasoningEffort: null, targetMinutes: 7, ...overrides,
  };
}
