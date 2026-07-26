import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  looksLikeConfirmCard,
  parseConfirmCard,
  serializeConfirmCard,
} from "../confirmCard";

const SAMPLE = `Short read

The sample project is mid-flight.

---

## Desk Confirmation Card

Tick, adjust, or elaborate.

### 1. [status] Where is this project now?

- [ ] Founding / greenfield
- [x] Mid-flight active work
- [ ] Maintenance — keep coherent
- [ ] Other (elaborate)

Elaborate (optional): Round 2 synthesis filed.

### 2. [direction] What should sittings mostly do?

- [x] Polish / craft
- [x] Judgment calls the user must make
- [ ] Triage & reply (outbound work)

Elaborate (optional): Spine/spec alignment.

### 3. [fences] What must the curator never auto-change?

- [x] Append-only records / logs / archives
- [x] Other (elaborate — name the paths)

Elaborate (optional): outputs/ regenerate-only.

### 4. [sweep_actions] After a sitting closes, what EXTRA work should happen beyond archive/restock?

- [ ] Nothing beyond desk close (archive + restock / familiarity)
- [x] Stage approved drafts to outbound (never transmit from Kettle)

Elaborate (optional): Sitting notes → LOG.md

Reply with ticks and deltas, or hit finish ✓ when this card is close enough.
`;

describe("looksLikeConfirmCard", () => {
  it("detects desk confirmation checklists", () => {
    assert.equal(looksLikeConfirmCard(SAMPLE), true);
  });
  it("rejects plain prose", () => {
    assert.equal(looksLikeConfirmCard("Hello — survey complete."), false);
  });
});

describe("parseConfirmCard", () => {
  it("parses sections and ticks; strips Other; empty elaborate for user", () => {
    const card = parseConfirmCard(SAMPLE);
    assert.match(card.preamble, /sample project is mid-flight/);
    assert.equal(card.sections.length, 4);
    assert.equal(card.sections[0].id, "status");
    assert.equal(card.sections[0].multi, false);
    // Pre-ticks from agent GFM are cleared — user starts blank
    assert.equal(
      card.sections[0].options.find((o) => o.label.startsWith("Mid-flight"))?.checked,
      false,
    );
    assert.equal(
      card.sections[0].options.every((o) => !o.checked),
      true,
    );
    // Other option is stripped from UI model
    assert.equal(
      card.sections[0].options.some((o) => /^other/i.test(o.label)),
      false,
    );
    assert.equal(card.sections[0].elaborate, "");
    assert.equal(card.sections[1].multi, true);
    assert.equal(card.sections[1].options.filter((o) => o.checked).length, 0);
    assert.match(card.epilogue, /finish/);
  });

  it("treats horizon as single-choice (radio), not only status", () => {
    const md = `## Desk Confirmation Card
### 1. [horizon] What would success look like? (choose one)
- [ ] Something finished, out the door
- [x] A living body of work that stays healthy
Elaborate (optional):
`;
    const card = parseConfirmCard(md);
    assert.equal(card.sections[0].multi, false);
    assert.equal(card.sections[0].options.every((o) => !o.checked), true);
  });
});

describe("serializeConfirmCard", () => {
  it("round-trips ticks the curator can read", () => {
    const card = parseConfirmCard(SAMPLE);
    card.sections[0].options.forEach((o) => {
      o.checked = o.label.startsWith("Maintenance");
    });
    const md = serializeConfirmCard(card);
    assert.match(md, /\[x\] Maintenance/);
    assert.match(md, /\[ \] Mid-flight/);
    assert.match(md, /User Answers/i);
  });
});
