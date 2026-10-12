import fs from "fs";
import os from "os";
import path from "path";

/**
 * PATH for finding and running the resume toolchain (codex, claude, pdflatex,
 * pdfinfo…). The web server is often launched from an IDE or launcher with a
 * bare PATH (/usr/local/bin:/usr/bin:/bin), so the usual macOS install
 * locations are appended after whatever PATH we inherited.
 */
export function toolPath(inherited = process.env.PATH ?? ""): string {
  const home = os.homedir();
  const extra = [
    path.join(home, ".local", "bin"),          // Codex CLI installer, pipx
    "/opt/homebrew/bin", "/opt/homebrew/sbin",   // Homebrew (Apple silicon): poppler
    "/usr/local/bin",                            // Homebrew (Intel), Claude Code
    "/Library/TeX/texbin",                       // MacTeX / BasicTeX
    path.join(home, "Library", "TinyTeX", "bin", "universal-darwin"),
    "/usr/bin", "/bin", "/usr/sbin", "/sbin",
  ].filter((d) => fs.existsSync(d));
  return [...new Set([...inherited.split(path.delimiter).filter(Boolean), ...extra])].join(path.delimiter);
}
