# Design

> Visual system and UI patterns for **StewardLedger**'s web surfaces.
> Companion to [`BRAND.md`](BRAND.md).
> This document is normative. If new code conflicts with anything below, fix the code.

The system is called **"Ledger Editorial"**: warm parchment surfaces, editorial serif display type, hairline rules, tabular numerals, one burnished brass accent used with restraint. The tokens and primitives live in `packages/web/src/app.css`. Read that file before adding new components.

---

## 1. Hard rules — never do

- ❌ Never use raw Tailwind slate colors in user-facing markup: `text-slate-*`, `bg-slate-*`, `border-slate-*`. Use the CSS variables instead (`var(--ink)`, `var(--ink-soft)`, `var(--ink-mute)`, `var(--ink-faint)`, `var(--rule)`, `var(--rule-strong)`, `var(--paper)`, `var(--paper-soft)`, `var(--card)`, `var(--card-warm)`).
- ❌ Never use Tailwind palette colors for semantic state: no `bg-rose-*`, `bg-emerald-*`, `bg-amber-*`, `bg-blue-*`, `text-rose-*`, `text-red-*`, `text-green-*`, `text-amber-*`, `text-blue-*`, `border-rose-*`, etc. Use the semantic variables: `var(--ok)`/`--ok-soft`, `var(--warn)`/`--warn-soft`, `var(--bad)`/`--bad-soft`, `var(--info)`/`--info-soft`, `var(--brass)`/`--brass-deep`/`--brass-soft`.
- ❌ Never style cards with `rounded-xl border bg-white shadow-sm`. Use `sl-card` or `sl-card-warm`.
- ❌ Never style buttons with `rounded-lg bg-slate-900 text-white`. Use `sl-btn sl-btn-primary` / `sl-btn-ghost` / `sl-btn-accent`.
- ❌ Never style inputs with `rounded-lg border border-slate-300 px-3 py-2`. Use `sl-input` / `sl-select`.
- ❌ Never style tables ad-hoc. Wrap in `sl-card` and use `sl-table`.
- ❌ Never write a section heading without an `sl-eyebrow` above it. Never write a page heading without `sl-display`.
- ❌ Never use more than one brass accent per view. The brass colour signals "the one thing that matters here" — usually the active nav item, an italic word in the page title, or a single primary action. Spread it thin.
- ❌ Never centre-constrain content with `max-w-2xl mx-auto px-6 py-8` etc. The role layout (`/zone`, `/church`, `/admin`, `/group`) already handles page padding. Pages just need `<div class="pt-2 pb-10 lg:pt-0">…` or no wrapper at all.

---

## 2. Tokens (CSS variables)

All tokens live in `:root` in `packages/web/src/app.css`. Reference by `var(--name)`.

### Surfaces

| Token | Use |
|---|---|
| `--paper` | Page background |
| `--paper-soft` | Sunken surfaces, table thead, hover row |
| `--card` | Raised surface (default `sl-card`) |
| `--card-warm` | Tinted card (filter blocks, forms, `sl-card-warm`) |

### Ink (text)

| Token | Use |
|---|---|
| `--ink` | Primary heading & body text |
| `--ink-soft` | Secondary body, table cells |
| `--ink-mute` | Captions, helper text, eyebrows |
| `--ink-faint` | Disabled / placeholder accents |

### Lines

| Token | Use |
|---|---|
| `--rule` | Default hairlines, borders, dividers |
| `--rule-strong` | Input borders, button ghost borders |

### Brass accent (use once per view)

| Token | Use |
|---|---|
| `--brass` | Active state, primary accent |
| `--brass-deep` | Hover on primary, italic in display headings, links on hover |
| `--brass-soft` | `sl-badge-accent` background, selection background |
| `--brass-glow` | Reserved for emphasis (rare) |

### Semantic state

| Token | Use |
|---|---|
| `--ok` / `--ok-soft` | Success, active, posted |
| `--warn` / `--warn-soft` | Warnings, pending review, expired |
| `--bad` / `--bad-soft` | Errors, destructive, voided |
| `--info` / `--info-soft` | Informational, scheduled |

### Type

| Token | Use |
|---|---|
| `--font-display` | Fraunces serif — headlines, table cell anchors, italic accent |
| `--font-body` | Geist sans — paragraph text, controls |
| `--font-mono` | JetBrains Mono — IDs, reference codes, amounts |

---

## 3. Typography utilities

Defined in `app.css`. Apply via `class=`.

| Class | What it does |
|---|---|
| `sl-display` | Fraunces serif, `-0.02em` letter-spacing. Page titles & numeric KPIs. |
| `sl-serif-italic` | Italic Fraunces. The accented word inside a page title. |
| `sl-mono` | JetBrains Mono with stylistic sets. IDs, reference codes, timestamps. |
| `sl-num` | Tabular-numeric, lining figures. Always use on money / count columns. |
| `sl-eyebrow` | Uppercase 11px label with `0.18em` letter-spacing. Section markers. |

**Page title pattern:**

```svelte
<span class="sl-eyebrow">§ II · Identities</span>
<h1 class="mt-3 sl-display text-[44px] leading-[1] text-[var(--ink)]">
  Members <span class="sl-serif-italic font-light text-[var(--brass-deep)]">directory</span>
</h1>
<p class="mt-2 text-[14px] text-[var(--ink-mute)]">
  Short, one-paragraph description of what this page is for.
</p>
```

The eyebrow uses a `§` mark plus a hierarchical label: `§ ROMAN · SECTION` (e.g. `§ II · Identities`) for primary sections, or `§ AREA · PAGE` (e.g. `§ Giving · Financial targets`) for secondary ones. Match the existing eyebrows; don't invent new section numbers.

The headline uses 44px on most pages, 40px on detail pages, 52px on landmark pages (paying-in books). The second word of the headline is the italic brass-deep accent — that's the *one* brass accent for the page.

---

## 4. Component primitives

### Cards: `sl-card`, `sl-card-warm`

```svelte
<div class="sl-card p-6">…</div>        <!-- raised content -->
<div class="sl-card-warm p-6">…</div>   <!-- tinted: filters, forms -->
```

A page typically has **one** `sl-card-warm` block (the filter / form bar near the top) and several `sl-card` blocks (tables, KPI tiles, lists below).

### Buttons: `sl-btn` + variant

```svelte
<button class="sl-btn sl-btn-primary">Save changes</button>
<button class="sl-btn sl-btn-ghost">Cancel</button>
<button class="sl-btn sl-btn-accent">Post</button>            <!-- brass; rare -->
<button class="sl-btn sl-btn-ghost" style="color:var(--bad)">Delete</button>
```

- **`sl-btn-primary`** — ink background, paper text. The page's main action.
- **`sl-btn-ghost`** — transparent with hairline border. Secondary actions.
- **`sl-btn-accent`** — brass background. Reserved for stand-out moments (e.g. Post a batch). Don't use on every page.
- **Destructive** — `sl-btn-ghost` with inline `style="color:var(--bad)"`. Don't introduce a `sl-btn-danger` variant.

### Inputs: `sl-input`, `sl-select`

```svelte
<label class="block">
  <span class="sl-eyebrow" style="font-size:10.5px">First name</span>
  <input type="text" bind:value={firstName} class="sl-input mt-1.5" />
</label>

<label class="block">
  <span class="sl-eyebrow" style="font-size:10.5px">Chapter</span>
  <select bind:value={chapterId} class="sl-select mt-1.5">…</select>
</label>
```

Every label is an `sl-eyebrow` (10.5px), not a `text-sm font-medium` heading. Helper text below an input is `text-[11.5px] text-[var(--ink-mute)]`.

For IDs / monospace values: `class="sl-input sl-mono text-[12.5px]"`. For amounts: `class="sl-input sl-num text-right"`.

### Tables: `sl-table` inside `sl-card`

```svelte
<div class="sl-card overflow-hidden">
  <table class="sl-table">
    <thead>
      <tr>
        <th>Code</th>
        <th>Name</th>
        <th class="!text-right">Amount</th>
        <th>Status</th>
      </tr>
    </thead>
    <tbody>
      {#each rows as r (r.id)}
        <tr>
          <td class="sl-mono text-[12px] text-[var(--ink-soft)]">{r.code}</td>
          <td class="text-[var(--ink)]">{r.name}</td>
          <td class="sl-num text-right text-[var(--ink)]">{r.amount}</td>
          <td><span class="sl-badge sl-badge-ok">{r.status}</span></td>
        </tr>
      {/each}
      {#if rows.length === 0}
        <tr>
          <td colspan="4" class="py-12 text-center text-[13px] text-[var(--ink-mute)]">
            No rows yet.
          </td>
        </tr>
      {/if}
    </tbody>
  </table>
</div>
```

Above every table, a row with the section eyebrow and count:

```svelte
<div class="mb-3 flex items-center justify-between">
  <span class="sl-eyebrow">Index of members</span>
  <span class="sl-mono text-[10.5px] text-[var(--ink-mute)]" style="letter-spacing:0.06em">
    {items.length} {items.length === 1 ? "row" : "rows"}
  </span>
</div>
```

### Badges: `sl-badge` + state

```svelte
<span class="sl-badge sl-badge-ok">active</span>
<span class="sl-badge sl-badge-warn">pending</span>
<span class="sl-badge sl-badge-bad">voided</span>
<span class="sl-badge sl-badge-info">scheduled</span>
<span class="sl-badge sl-badge-mute">draft</span>
<span class="sl-badge sl-badge-accent">primary</span>
```

Status mapping conventions across the app:

| Domain status | Badge variant |
|---|---|
| `active`, `posted`, `committed`, `merged`, `matched` | `sl-badge-ok` |
| `pending`, `running`, `submitted`, `expired (still actionable)` | `sl-badge-warn` |
| `voided`, `failed`, `rejected`, `dismissed`, `reversal` | `sl-badge-bad` |
| `scheduled`, `approved` | `sl-badge-info` |
| `draft`, `inactive`, `rolled_back`, `open` | `sl-badge-mute` |
| Highlight (primary address, ready-to-merge) | `sl-badge-accent` |

Don't add new variants; pick the closest existing one.

### Inline status banners

Errors:

```svelte
<p class="border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">
  {error}
</p>
```

Warnings: same shape, `--warn` / `--warn-soft`. Success: `--ok`. Info: `--info`.

Never use `rounded-lg bg-rose-50 text-rose-700` etc.

### Links

```svelte
<a href="…" class="sl-link">Inline link</a>
<a href="…" class="text-[var(--brass-deep)] hover:underline">Subtle link</a>
```

For table-cell name links, treat the name as a display anchor:

```svelte
<a href={`/zone/members/${m.id}`} class="sl-display text-[15px] text-[var(--ink)] hover:text-[var(--brass-deep)]">
  {memberDisplayName(m)}
</a>
```

### Reveals (page entry animation)

Stagger top-level page sections with `sl-reveal sl-reveal-N` (N = 1..6):

```svelte
<div class="sl-reveal sl-reveal-1">… header …</div>
<form class="sl-reveal sl-reveal-2 sl-card-warm …">… filters …</form>
<div class="sl-reveal sl-reveal-3">… table …</div>
```

Don't stack reveals deeper than the visible top of the page; below-the-fold sections don't need them.

### Empty states

For a table, the empty row in `<tbody>` (see Table example above). For a whole-card empty state:

```svelte
<div class="sl-card flex flex-col items-center justify-center p-16 text-center">
  <span class="sl-display text-[36px] italic text-[var(--brass-deep)]">∅</span>
  <p class="mt-4 sl-display text-[18px] italic text-[var(--ink)]">No items yet.</p>
  <p class="mt-2 text-[13px] text-[var(--ink-mute)]">Add the first one above.</p>
</div>
```

### Modals / overlays

Use `ConfirmDialog.svelte` for destructive confirms. For custom dialogs, the backdrop is **always**:

```svelte
<div class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-8"
     style="background: rgba(21, 22, 26, 0.42);">
  <div class="w-full max-w-md border border-[var(--rule)] bg-[var(--card)] shadow-[var(--shadow-lift)]">
    …
  </div>
</div>
```

Never use `bg-slate-900/40` or `rounded-xl bg-white shadow-xl`.

---

## 5. Canonical page template

This is the structure every new index page should follow. Copy-paste, then fill in.

```svelte
<svelte:head><title>Page name · StewardLedger</title></svelte:head>

<div class="pt-2 pb-10 lg:pt-0">
  <!-- 1. Header: eyebrow + display heading + mute description + actions -->
  <div class="sl-reveal sl-reveal-1 flex flex-wrap items-end justify-between gap-6">
    <div>
      <span class="sl-eyebrow">§ AREA · Page</span>
      <h1 class="mt-3 sl-display text-[44px] leading-[1] text-[var(--ink)]">
        Primary <span class="sl-serif-italic font-light text-[var(--brass-deep)]">noun</span>
      </h1>
      <p class="mt-2 text-[14px] text-[var(--ink-mute)]">
        One-sentence description.
      </p>
    </div>
    <div class="flex flex-wrap items-center gap-3">
      <button class="sl-btn sl-btn-ghost">Secondary</button>
      <button class="sl-btn sl-btn-primary">Primary action</button>
    </div>
  </div>

  <!-- 2. Filters / create form: ONE sl-card-warm block -->
  <form class="sl-reveal sl-reveal-2 sl-card-warm mt-8 grid grid-cols-12 gap-3 p-6">
    <label class="col-span-12 sm:col-span-4">
      <span class="sl-eyebrow" style="font-size:10.5px">Field label</span>
      <input class="sl-input mt-1.5" />
    </label>
    …
  </form>

  <!-- 3. Table section with eyebrow header + count -->
  <div class="sl-reveal sl-reveal-3 mt-8">
    <div class="mb-3 flex items-center justify-between">
      <span class="sl-eyebrow">Index of items</span>
      <span class="sl-mono text-[10.5px] text-[var(--ink-mute)]" style="letter-spacing:0.06em">
        {items.length} {items.length === 1 ? "row" : "rows"}
      </span>
    </div>
    <div class="sl-card overflow-hidden">
      <table class="sl-table">…</table>
    </div>
  </div>
</div>
```

**Detail pages** (`/zone/members/[id]`, `/zone/contributions/[id]`, etc.) follow the same skeleton but:

- Top-row back link as a small `sl-btn-ghost`: `<a href=".." class="sl-btn sl-btn-ghost">← Back to directory</a>`.
- Headline is 40px (not 44px).
- A monospace reference code line sits between the eyebrow and the headline.
- Editable form is one `sl-card-warm` block; sub-sections (Addresses, Lines, etc.) are `sl-card` blocks each with their own eyebrow header.

---

## 6. Spacing & layout conventions

- Page outer wrapper: `class="pt-2 pb-10 lg:pt-0"`. Role layouts (`/zone/+layout.svelte` etc.) own the horizontal padding.
- Between page-level sections: `mt-8` (32px) or `mt-10` (40px) for the next major block.
- Between header and the first sub-line: `mt-3` (eyebrow → headline) then `mt-2` (headline → description).
- Inside cards: `p-6` for full forms / filter blocks, `p-5` for KPI tiles, `p-4` for compact tiles.
- Table-section eyebrow row: `mb-3` before the table.
- Field label gap: `mt-1.5` between `sl-eyebrow` and the input.

---

## 7. Sidebar navigation

`sl-side-link` (+ `sl-side-link-active` for the current page) and `sl-side-link-rail` are pre-styled. Don't override. Sidebar groups use `sl-eyebrow` for their headers. New nav items go in `packages/web/src/lib/nav.ts` — never inline a sidebar list in a layout.

Sidebar item labels:
- Are short (1–3 words), Title-case ("Members", "Duplicate members").
- Describe the page from the user's perspective, not the implementation ("Duplicate members", not "Merge proposals").
- Stay consistent with the page's own headline noun.

---

## 8. Copy conventions

- Page headlines: **two words**, second word italicised — e.g. *Members directory*, *Financial targets*, *Audit search*, *Paying-in books*.
- Eyebrows: `§ ROMAN · SECTION` for primary surfaces, `§ AREA · PAGE` for secondary.
- Help text under fields: 11.5px, `text-[var(--ink-mute)]`, no sentence-ending period if it's a fragment.
- Destructive confirms (`confirm()` or `ConfirmDialog`): explain what will happen *and* what's reversible — e.g. "The duplicate will be archived, not deleted, and every merge is recorded in the audit log."
- Status pills: lowercase ("posted", "merged"), single word where possible.
- Empty states: tell the user the next action — "No duplicate pairs queued. Add one above when you find two records for the same person."
- Buttons: action verb, present tense ("Save changes", "Add row", "Merge now"). Avoid "Submit", "OK", "Click here".

---

## 9. Before you add a new page

1. Open a sibling page in the same role surface (`/zone/members/+page.svelte`, `/zone/audit/+page.svelte`, etc.) and copy its skeleton.
2. Pick the existing `§ ROMAN · SECTION` that fits, or `§ AREA · PAGE` for secondary surfaces.
3. Pick the existing badge variants that fit your states — don't invent new ones.
4. Check `app.css` for any `sl-*` class you need before reaching for raw Tailwind.
5. After writing the page, run:
   ```
   pnpm -F @stewardledger/web exec svelte-check
   ```
   And grep your new file for the forbidden patterns:
   ```
   grep -E "text-slate|bg-slate|border-slate|rounded-(lg|xl) (border|bg-white)|text-(rose|red-[0-9]|green-[0-9]|amber-[0-9]|blue-[0-9])|bg-(rose|emerald|amber|blue-[0-9])" your-new-page.svelte
   ```
   Both should return zero matches.

---

## 10. Where things live

- Tokens & primitives: `packages/web/src/app.css`
- Role layouts (sidebar shell, header, padding): `packages/web/src/routes/{zone,church,admin,group}/+layout.svelte`
- Navigation source-of-truth: `packages/web/src/lib/nav.ts`
- Reusable UI bits: `packages/web/src/lib/ConfirmDialog.svelte`, `packages/web/src/lib/contributions/*.svelte`
- Reference pages (good templates to copy from):
  - Index + table: `packages/web/src/routes/zone/members/+page.svelte`
  - Detail page: `packages/web/src/routes/zone/members/[id]/+page.svelte`
  - Filter + KPIs + table: `packages/web/src/routes/zone/imports/[id]/+page.svelte`
  - Form + queue list: `packages/web/src/routes/zone/duplicates/+page.svelte`
