/**
 * Plain-text project lead lines for the Desk Brief pane (no vscode imports).
 */
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Strip GFM markers for plain one-liners (project summary, takeaway).
 * Keeps link/image labels; drops **bold**, *em*, `code`, headings, etc.
 */
export function stripMarkdownToPlain(src: string): string {
  let s = String(src || "");
  s = s.replace(/```[\s\S]*?```/g, " ");
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, "$1");
  s = s.replace(/___([^_]+)___/g, "$1");
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
  s = s.replace(/__([^_]+)__/g, "$1");
  s = s.replace(/\*([^*]+)\*/g, "$1");
  s = s.replace(/_([^_]+)_/g, "$1");
  s = s.replace(/`([^`]+)`/g, "$1");
  s = s.replace(/^#{1,6}\s+/gm, "");
  s = s.replace(/^\s*[-*+]\s+/gm, "");
  s = s.replace(/^\s*\d+\.\s+/gm, "");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/**
 * One plain sentence about the project for the empty Brief pane (no entry selected).
 * Prefer `.kettle/PROJECT.md`, then README; else a short name-based fallback.
 */
export function projectSummarySentence(
  projectRoot: string | undefined,
  projectName: string,
): string {
  const name = (projectName || "This project").trim() || "This project";
  if (!projectRoot) {
    return `${name} is open on this desk.`;
  }
  const candidates = [
    path.join(projectRoot, ".kettle", "PROJECT.md"),
    path.join(projectRoot, "README.md"),
  ];
  for (const file of candidates) {
    try {
      const raw = fs.readFileSync(file, "utf8");
      const sentence = firstMarkdownSentence(raw);
      if (sentence) return sentence;
    } catch {
      /* try next */
    }
  }
  return `${name} is open on this desk.`;
}

/** First prose sentence from markdown (skip headings, fences, list-only lines). */
function firstMarkdownSentence(md: string): string | undefined {
  const lines = String(md || "").split(/\n/);
  const chunks: string[] = [];
  let buf: string[] = [];
  let inFence = false;
  const flush = () => {
    if (buf.length) {
      chunks.push(buf.join(" ").replace(/\s+/g, " ").trim());
      buf = [];
    }
  };
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith("```")) {
      inFence = !inFence;
      flush();
      continue;
    }
    if (inFence) continue;
    if (
      !t ||
      t.startsWith("#") ||
      t.startsWith("---") ||
      t.startsWith("***") ||
      t.startsWith("|") ||
      t.startsWith(">") ||
      t.startsWith("- ") ||
      t.startsWith("* ") ||
      /^\d+\.\s/.test(t)
    ) {
      flush();
      continue;
    }
    buf.push(t);
  }
  flush();
  const para = chunks.find((c) => stripMarkdownToPlain(c).length >= 12);
  if (!para) return undefined;
  const plain = stripMarkdownToPlain(para);
  const m = plain.match(/^(.+?[.!?])(\s|$)/);
  const s = (m ? m[1] : plain).trim();
  if (s.length > 280) return s.slice(0, 277).trimEnd() + "…";
  return s || undefined;
}
