import { win32 } from "path";

// Derives the agent-storage directory name for a workspace cwd
// (e.g. "/Users/x/code/proj" → "Users-x-code-proj").
// path.win32.parse handles drive letters, UNC roots, and Unix roots on all platforms.
export function projectDirNameFromCwd(cwd: string): string {
  const { root } = win32.parse(cwd);
  const withoutRoot = cwd.slice(root.length).replace(/[\\/]+$/, "");
  // Sanitize root: strip colons and separators, keep letters (e.g. "C:\" → "C", "\\server\share\" → "server-share")
  const sanitizedRoot = root.replace(/[:\\/]+/g, "-").replace(/^-+|-+$/g, "");
  const prefix = sanitizedRoot ? sanitizedRoot + "-" : "";
  if (!withoutRoot) {
    return sanitizedRoot || "root";
  }
  return prefix + withoutRoot.replace(/[\\/]+/g, "-");
}
