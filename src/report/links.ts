import type { ReportMeta, SourceLocation } from "../types.js";
import { codeSpan, encodeUrlSegment, repoRelativePath, safeUrl } from "./sanitize.js";

const SHA = /^[0-9a-f]{7,64}$/i;
const MAX_PATH = 500;

/**
 * Permalink to a source location: the head SHA for head-side lines, the base SHA for code the PR
 * deleted (`side: "base"`). Null when the repo or the needed SHA is unknown (local CLI runs, a base
 * SHA the action did not get), the SHA is not hex, the server URL is not https, or the file is not a
 * plain repository-relative path. Built only from validated parts, so the result is a safe link target.
 */
export function locationUrl(loc: SourceLocation, meta: ReportMeta): string | null {
  const repo = meta.repo;
  const sha = loc.side === "base" ? meta.baseSha : meta.headSha;
  if (!repo || !sha || !SHA.test(sha)) return null;
  const origin = serverOrigin(repo.serverUrl);
  const path = repoRelativePath(loc.file, MAX_PATH);
  if (origin === null || path === null || !repo.owner || !repo.name) return null;
  const encodedPath = path.split("/").map(encodeUrlSegment).join("/");
  const owner = encodeUrlSegment(repo.owner);
  const name = encodeUrlSegment(repo.name);
  return `${origin}/${owner}/${name}/blob/${sha}/${encodedPath}${lineAnchor(loc)}`;
}

/** "main.tf:12", "main.tf:12-14", plus " (deleted)" for base-side locations. */
export function locationLabel(loc: SourceLocation): string {
  const file = loc.file.trim().replace(/^(?:\.\/)+/, "") || "?";
  const range = lineRange(loc);
  const where = range === null ? file : `${file}:${range}`;
  return loc.side === "base" ? `${where} (deleted)` : where;
}

/** Markdown for a location: a linked code span when a permalink can be built, else plain code. */
export function locationMarkdown(loc: SourceLocation, meta: ReportMeta): string {
  const label = codeSpan(locationLabel(loc), 200);
  const url = locationUrl(loc, meta);
  return url ? `[${label}](${url})` : label;
}

/** Link to the workflow run, when the meta carries a safe one. */
export function runUrl(meta: ReportMeta): string | null {
  return safeUrl(meta.run?.url);
}

function lineRange(loc: SourceLocation): string | null {
  if (!isPositiveInteger(loc.startLine)) return null;
  const end = isPositiveInteger(loc.endLine) && loc.endLine > loc.startLine ? loc.endLine : loc.startLine;
  return end === loc.startLine ? `${loc.startLine}` : `${loc.startLine}-${end}`;
}

function lineAnchor(loc: SourceLocation): string {
  const range = lineRange(loc);
  if (range === null) return "";
  const [start, end] = range.split("-");
  return end === undefined ? `#L${start}` : `#L${start}-L${end}`;
}

/** Origin of an https server URL (GitHub.com or GitHub Enterprise Server); null otherwise. */
function serverOrigin(serverUrl: string): string | null {
  const url = safeUrl(serverUrl.trim().replace(/\/+$/, ""));
  if (url === null) return null;
  try {
    const parsed = new URL(url);
    return parsed.username || parsed.password ? null : parsed.origin;
  } catch {
    return null;
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
