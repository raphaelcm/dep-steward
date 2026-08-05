# Homepage brand language

The design record for `docs/index.html` — what the choices are and why, so future
edits stay in register. Genre reference: [Docent](https://danmunz.github.io/docent/)
(single self-contained page, warm paper, hard offset shadows, line-art hero, real
copy-paste code). dep-steward borrows the genre, not the identity.

## Register: the steward's desk

A steward is an old profession: entrusted care, meticulous records, judgment
exercised on someone's behalf. The page's register is the estate ledger — paper,
iron-gall ink, a ledger's double rules, a wax seal for things that need the
owner's hand. Not the art gallery (Docent), not the neon dev-tool.

## Palette

| Token | Value | Role |
|---|---|---|
| `--paper` | `#FAF7F0` | page ground |
| `--card` | `#FFFDF8` | cards, slips, panels |
| `--linen` / `--parchment` / `--stone` | `#F2EDE1` / `#E8E0CD` / `#C7BDA6` | bands, fills, rules |
| `--graphite` / `--charcoal` / `--ink` | `#6E6757` / `#3A352A` / `#211D14` | text + borders |
| `--ledger` / `--ledger-deep` | `#2E6B4F` / `#1F4A37` | the safe path: merges, checks, links |
| `--wax` / `--wax-deep` | `#A03123` / `#7E2418` | escalation: the seal, `needs-human-review` |
| `--brass` | `#97803B` | caution accents (prereq dashes) |

Green means "the gate passed it"; wax red means "a human's hand is required."
Those two meanings are load-bearing — don't reassign them decoratively.

## Type

- **Fraunces** (SIL OFL) — display and body. Variable, optical sizing on; 900 for
  the hero, 600 for headings, 400 for body. The italic accent line in the hero is
  the one theatrical move on the page.
- **IBM Plex Mono** (SIL OFL) — code, kickers, labels, chips. 400/500.
- Both embedded as base64 latin-subset woff2 **inside the single HTML file**.
  The page makes zero external requests by design: the injection-safety product
  gets a supply-chain-clean homepage. Keep it that way — no CDNs, no analytics,
  no external images.

## Drawing rules (the SVG art)

- Engraved line-art: `#211D14` strokes, 2–2.6px, round caps/joins; fills limited
  to `--card`/`--linen`/`--parchment` plus the two accent meanings above.
- Motifs: the **seal** (ring + gate + green check — also the favicon), crates as
  dependency PRs, the **gate**, the **wax seal**, the **service bell** ("finds you").
- Hard offset shadows (`3–8px 0` charcoal), 2px ink borders, 4px double rules
  between sections — the ledger's geometry, applied sparingly.

## Voice

The README's voice, compressed: literate, plain-spoken, zero hype. Every claim on
the page must be a claim the README already makes — the page markets by being
precise, not by promising. Hero pattern mirrors Docent's ("There's artwork *on TV
tonight.*" → "There's a steward *on your repo.*").

## Guardrails

- One file: `docs/index.html`. Assets are only `favicon.svg` + `og-image.png`.
- `test/homepage.test.mjs` pins: assets resolve, the install one-liner is
  byte-identical to the README's, and the commands the page advertises are the
  skills that exist. Edit the page and the README together or the suite goes red.
