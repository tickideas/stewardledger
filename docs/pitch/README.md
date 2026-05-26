# StewardLedger Pitch

> Pitch deck for the pastor evaluating Church Plus v2 vs StewardLedger.
> The deck lives in [`STEWARDLEDGER-PITCH.md`](STEWARDLEDGER-PITCH.md) as Marp-compatible Markdown.

---

## What's here

| File | Purpose |
|---|---|
| `STEWARDLEDGER-PITCH.md` | The full deck (~21 slides). Marp-formatted Markdown; one slide per `---` block. |
| `STEWARDLEDGER-HANDOUT.md` | The one-page A4 take-away for Pastor after the meeting. Marp-formatted. |
| `README.md` (this file) | How to read, present, and export both. |

## How to read it

Plain Markdown — every horizontal rule (`---`) is a new slide. Just scroll.

GitHub renders it fine for review.

## How to present it

### Option 1 — Marp CLI to PDF / PPTX

Requires Node:

```sh
# one-off install
pnpm dlx @marp-team/marp-cli --version || npm i -g @marp-team/marp-cli

# export the full deck
marp docs/pitch/STEWARDLEDGER-PITCH.md --pdf      # → STEWARDLEDGER-PITCH.pdf
marp docs/pitch/STEWARDLEDGER-PITCH.md --pptx     # → STEWARDLEDGER-PITCH.pptx
marp docs/pitch/STEWARDLEDGER-PITCH.md --html     # → STEWARDLEDGER-PITCH.html (preview)

# export the one-page A4 handout
marp docs/pitch/STEWARDLEDGER-HANDOUT.md --pdf --allow-local-files
```

### Option 2 — VS Code Marp extension

Install the **Marp for VS Code** extension, open the deck, click "Open Preview". Export from the preview header.

### Option 3 — Slides.com / Google Slides

Copy the Markdown, paste into your preferred deck tool, restyle. The slide content is the asset; the layout is replaceable.

## The handout

`STEWARDLEDGER-HANDOUT.md` is a single A4 page intended to be **printed and left with the pastor** at the end of the meeting. It mirrors the deck's structure but compresses it into:

- One headline + tagline.
- A 10-row comparison table (Church Plus v2 vs StewardLedger).
- Three short lists: shipping today, planned, adoption strategy.
- The three asks.

Design rules for the handout:

- Always one page. Anything that won't fit doesn't belong.
- Same tone as the deck — respectful, no people-comparisons.
- The CSS in the handout's front-matter is the only inline styling we accept. Keep it; do not add brand colours beyond the brass `#c9a010` accent and warm parchment greys already in `BRAND.md`.

## How to tweak

- Each slide is a `---`-separated section. Don't merge sections — the slide order matters.
- The brand line, tagline, and stack table are intentionally consistent with the rest of `docs/` (`PRD.md`, `ARCHITECTURE.md`, `BRAND.md`). If those change, update this deck too.
- The "What's already built" slide enumerates real shipped features — keep it factual. If a feature ships or is removed, update the slide.
- The "What's planned next" slide mirrors `docs/ROADMAP.md` and `docs/CHURCHPLUS-PORT-NOTES.md`. Keep them aligned.
- The "Adoption strategy" slide is the strongest hook with the pastor. Don't dilute it; the offer is **a free 2-week pilot with a documented decision gate**.

## Tone

Respectful, never dismissive of the Indian developer team or their work on Church Plus v2. We compete on platform shape, not on people. The deck is engineered to make Pastor's choice easier, not to embarrass anyone.

## Authoring conventions

- Single sentence per bullet where possible.
- Two-column tables for comparisons; markdown renders cleanly in Marp.
- No emojis in delivery; use only `*emphasis*` and `**strong**`.
- Sparing use of italics. Pastor reads carefully.

## Audit trail

| Date | Change |
|---|---|
| 2026-05-26 | Initial draft (v0.1). |
