/*
 * Read-only access to the repository checkout. Every path is repo-relative; anything that resolves
 * outside the root (`..`, absolute paths, symlinks pointing out) reads as missing. So does a
 * Terraform plan or state JSON (whatever its name): they hold every value in clear text, and the
 * plan the review reads often sits in the checkout (`terraform show -json plan.out > plan.json`).
 */
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import type { Workspace } from "./types.js";

/** Files larger than this read as missing (Terraform sources are small; this keeps memory bounded). */
export const MAX_WORKSPACE_FILE_BYTES = 1024 * 1024;

/**
 * Repo-relative, forward slashes, no `./`, no trailing slash; "" for the root. Null for absolute
 * paths, paths escaping the root, and paths with NUL bytes.
 */
export function normalizeRepoPath(path: string): string | null {
  if (path.includes("\0")) return null;
  const p = path.replace(/\\/g, "/").trim();
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return null;
  const normalized = posix.normalize(p === "" ? "." : p).replace(/\/+$/, "");
  if (normalized === "." || normalized === "") return "";
  if (normalized === ".." || normalized.startsWith("../")) return null;
  return normalized;
}

/**
 * Whether text is (or holds) a Terraform plan or state JSON: `terraform show -json` output, a raw
 * state file, or either inside wrapper noise. Keys only, so a .tf.json file never matches.
 */
export function isPlanOrStateText(text: string): boolean {
  return (
    /"terraform_version"\s*:/.test(text) &&
    /"(format_version|lineage|serial)"\s*:/.test(text) &&
    /"(planned_values|resource_changes|resource_drift|prior_state|values|resources|outputs|variables|configuration)"\s*:/.test(
      text,
    )
  );
}

export function createFsWorkspace(root: string, rootModuleDir: string): Workspace {
  const absRoot = resolve(root);
  let realRoot: Promise<string> | null = null;
  const getRealRoot = (): Promise<string> => (realRoot ??= realpath(absRoot).catch(() => absRoot));

  /** Absolute real path of a repo path when it stays inside the root, else null. */
  const resolveInside = async (repoPath: string): Promise<string | null> => {
    const rel = normalizeRepoPath(repoPath);
    if (rel === null) return null;
    const rootReal = await getRealRoot();
    let real: string;
    try {
      real = await realpath(join(absRoot, rel));
    } catch {
      return null;
    }
    return isInside(rootReal, real) ? real : null;
  };

  return {
    root: absRoot,
    rootModuleDir: normalizeRepoPath(rootModuleDir) ?? rootModuleDir,

    async readFile(repoPath: string): Promise<string | null> {
      try {
        const real = await resolveInside(repoPath);
        if (real === null) return null;
        const info = await stat(real);
        if (!info.isFile() || info.size > MAX_WORKSPACE_FILE_BYTES) return null;
        const text = await readFile(real, "utf8");
        return isPlanOrStateText(text) ? null : text;
      } catch {
        return null;
      }
    },

    async listFiles(repoDir: string, suffixes: readonly string[]): Promise<string[]> {
      try {
        const dir = normalizeRepoPath(repoDir);
        if (dir === null) return [];
        const real = await resolveInside(dir);
        if (real === null) return [];
        const rootReal = await getRealRoot();
        const entries = await readdir(real);
        const out: string[] = [];
        for (const name of entries) {
          if (suffixes.length && !suffixes.some((s) => name.endsWith(s))) continue;
          const full = join(real, name);
          try {
            const link = await lstat(full);
            const target = link.isSymbolicLink() ? await realpath(full) : full;
            if (!isInside(rootReal, target)) continue;
            if (!(await stat(target)).isFile()) continue;
          } catch {
            continue;
          }
          out.push(dir === "" ? name : `${dir}/${name}`);
        }
        return out.sort();
      } catch {
        return [];
      }
    },
  };
}

function isInside(root: string, path: string): boolean {
  if (path === root) return true;
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}
