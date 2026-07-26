/**
 * Parse / serialize founding confirmation cards from curator GFM.
 * UX rules (plugin sitting):
 *  - no "Other" checkboxes (Elaborate free text is the other answer)
 *  - no [id] · multi chrome in the UI (ids stay in serialized GFM for the agent)
 *  - empty elaborate fields for the user
 */

export type ConfirmOption = { checked: boolean; label: string };

export type ConfirmSection = {
  num: string;
  id: string;
  stem: string;
  multi: boolean;
  options: ConfirmOption[];
  elaborate: string;
};

export type ConfirmCard = {
  preamble: string;
  sections: ConfirmSection[];
  epilogue: string;
};

export function looksLikeConfirmCard(text: string): boolean {
  const t = String(text || "");
  if (!/- \[[ xX]\] /.test(t)) return false;
  return /confirmation\s+card|###\s*\d+\.\s*\[/i.test(t);
}

export function isOtherOptionLabel(label: string): boolean {
  const s = String(label || "")
    .trim()
    .toLowerCase();
  if (!s.startsWith("other")) return false;
  if (s === "other" || s.startsWith("other (")) return true;
  return s.includes("elaborate");
}

export function parseConfirmCard(text: string): ConfirmCard {
  const lines = String(text || "")
    .replace(/\r\n/g, "\n")
    .split("\n");
  const SECTION_RE = /^###\s*(\d+)\.\s*\[([^\]]+)\]\s*(.+?)\s*$/;
  const OPT_RE = /^- \[([ xX])\]\s+(.+?)\s*$/;
  const ELAB_RE = /^Elaborate(?:\s*\(optional\))?:\s*(.*)$/i;
  const CARD_HEAD_RE = /^##\s+.*confirmation\s+card/i;

  let start = lines.findIndex((l) => CARD_HEAD_RE.test(l.trim()));
  if (start < 0) start = lines.findIndex((l) => SECTION_RE.test(l.trim()));
  if (start < 0) {
    return { preamble: String(text || "").trim(), sections: [], epilogue: "" };
  }

  let preamble = lines.slice(0, start).join("\n").trim();
  let i = start;
  if (CARD_HEAD_RE.test((lines[i] || "").trim())) {
    i += 1;
    const intro: string[] = [];
    while (i < lines.length && !SECTION_RE.test(lines[i].trim())) {
      intro.push(lines[i]);
      i++;
    }
    const introText = intro.join("\n").trim();
    if (introText) preamble = preamble ? `${preamble}\n\n${introText}` : introText;
  }

  const sections: ConfirmSection[] = [];
  while (i < lines.length) {
    const m = lines[i].trim().match(SECTION_RE);
    if (!m) break;
    const num = m[1];
    const id = m[2].trim();
    const rawStem = m[3].trim();
    // Match core static/index.html: single-choice from "(choose one)" tag, then known ids.
    const single =
      /\((?:choose one|single choice)\)\s*$/i.test(rawStem) ||
      id === "status" ||
      id === "horizon";
    let stem = rawStem
      .replace(/\s*\((?:multi-select|single choice|choose one)\)\s*$/i, "")
      .replace(/\s*\[[\w]+\]\s*·\s*(multi|pick one)\s*$/i, "")
      .trim();
    i++;
    const options: ConfirmOption[] = [];
    while (i < lines.length) {
      const t = lines[i].trim();
      if (SECTION_RE.test(t)) break;
      const om = t.match(OPT_RE);
      if (om) {
        const label = om[2].trim();
        if (!isOtherOptionLabel(label)) {
          // Always start blank for the user — agent/survey pre-ticks are suggestions
          // only (and often wrong); pre-filled boxes read as "already answered."
          options.push({ checked: false, label });
        }
        i++;
        continue;
      }
      const em = t.match(ELAB_RE);
      if (em) {
        // Skip agent-prefilled elaborate; user fills empty.
        i++;
        while (i < lines.length) {
          const nt = lines[i].trim();
          if (!nt) {
            i++;
            if (
              i < lines.length &&
              (SECTION_RE.test(lines[i].trim()) ||
                OPT_RE.test(lines[i].trim()) ||
                /^Reply with/i.test(lines[i].trim()))
            ) {
              break;
            }
            continue;
          }
          if (
            SECTION_RE.test(nt) ||
            OPT_RE.test(nt) ||
            ELAB_RE.test(nt) ||
            /^---+$/.test(nt) ||
            /^Reply with/i.test(nt) ||
            /^##\s/.test(nt)
          ) {
            break;
          }
          i++;
        }
        continue;
      }
      if (/^---+$/.test(t) || /^Reply with/i.test(t) || /^##\s/.test(t)) break;
      i++;
    }
    if (options.length) {
      sections.push({
        num,
        id,
        stem,
        multi: !single,
        options,
        elaborate: "",
      });
    }
  }
  return {
    preamble,
    sections,
    epilogue: lines.slice(i).join("\n").trim(),
  };
}

export function serializeConfirmCard(card: ConfirmCard): string {
  const parts = ["## Desk Confirmation (User Answers)", ""];
  for (const s of card.sections || []) {
    parts.push(`### ${s.num}. [${s.id}] ${s.stem}`);
    for (const o of s.options || []) {
      parts.push(`- [${o.checked ? "x" : " "}] ${o.label}`);
    }
    const elab = (s.elaborate || "").trim();
    parts.push(elab ? `Elaborate: ${elab}` : "Elaborate: (none)");
    parts.push("");
  }
  parts.push("Card returned — proceed from these ticks (finish ✓ when ready).");
  return parts.join("\n").trim();
}

/**
 * Strip internal id / multi chrome from GFM for display-only paths
 * (when a card cannot be upgraded, never show `[status] · multi` to the user).
 */
export function sanitizeInterviewDisplay(text: string): string {
  return String(text || "")
    .replace(/^###\s*(\d+)\.\s*\[[^\]]+\]\s*/gm, "### $1. ")
    .replace(/\s*\((?:multi-select|single choice)\)\s*/gi, " ")
    .replace(/\s*\[([a-z0-9_]+)\]\s*·\s*(multi|pick one)/gi, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}
