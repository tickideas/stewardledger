---
applyTo: "packages/web/**/*.{ts,svelte}"
---

# Copilot review instructions — Web (SvelteKit 2 + Svelte 5)

Scope: `packages/web/src/**`. Read alongside `.github/copilot-instructions.md` and `AGENTS.md`.

## Non-negotiables

### 1. Auth, session & tenant scope
- The session is loaded server-side in `hooks.server.ts` and exposed via `event.locals.session`. Route gates live in each shell's `+layout.server.ts`. Flag any new protected route that does not import / extend the shell gate.
- The client store is `session.svelte.ts` and is hydrated from SSR data — do not call `/api/public/session-zones` again from the client.
- Tenant scope for API calls comes from `currentZoneSlug()` in `src/lib/api.ts`. Do not bypass `api.ts` with raw `fetch` to the API origin — the zone slug header and `credentials: "include"` will be missing.
- Never trust `zone` / `zoneSlug` from the URL for authorisation. The API enforces it; the web only uses it to scope reads.

### 2. Data loading
- Prefer `+page.server.ts` / `+layout.server.ts` `load` for initial data — keeps the API origin / cookie scope working under split-host deployments and avoids client-side flicker.
- In server `load`, use `event.fetch` (not global `fetch`) so SvelteKit forwards cookies correctly during SSR.
- Client-side calls must go through `src/lib/api.ts` (`request<T>`). For long-lived or supersedable requests (typeahead, list filters, statement reloads) pass an `AbortSignal` and handle `isAbortError(err)`.
- Surface `ApiError` to the user with `err.code` / `err.message` — do not stringify the whole error.

### 3. Svelte 5 idioms
- New components use runes: `$state`, `$derived`, `$effect`, `$props`. Do not write legacy `export let` / `$:` in new code unless modifying an existing legacy file (keep the file consistent).
- `$effect` is for side effects (subscriptions, DOM, network). Derived values belong in `$derived`. Flag `$effect` blocks that only compute a value.
- `$state` on objects/arrays is deep-reactive — do not wrap with extra reactivity helpers.
- Co-locate component-level state in `.svelte` files; share cross-route state via `*.svelte.ts` stores (see `session.svelte.ts`, `active-chapter.svelte.ts`).

### 4. XSS & content safety
- `{@html …}` is only acceptable for content that has already been sanitised server-side, or for inert HTML the app generated itself (e.g. a markdown renderer). Flag any `{@html}` that interpolates user-supplied strings without sanitisation.
- Do not build URLs by string-concatenating user input. Use `URL` / `URLSearchParams`.
- File downloads / signed URLs must come from the API — never construct an S3 / R2 URL in the browser.

### 5. Forms & mutations
- Mutations go through SvelteKit form actions (`+page.server.ts` `actions`) or the `api.ts` helper. Either path must surface validation errors with field-level messages.
- After a successful mutation, invalidate via `invalidate(...)` / `invalidateAll()` or rely on the form action's auto-invalidation — do not manually mutate page data in place.
- CSRF: rely on SvelteKit's default origin check for form actions. Do not disable it.

### 6. Money & dates in the UI
- Format money via the helpers in `src/lib/format.ts`. Never call `.toFixed(2)` on a money string.
- Always display the `currency_code` next to the amount. Do not assume a default currency.
- Dates: format with the shared helpers; never `new Date(str).toLocaleString()` directly in a component — timezone drift will hit you in reports.

### 7. Accessibility & UX baseline
- Buttons must have a label (visible text or `aria-label`). Icon-only buttons need `aria-label`.
- Form inputs must have an associated `<label for>` or `aria-labelledby`.
- Loading and empty states are required for any list / table view — flag if missing.
- Use semantic HTML (`<button>`, `<a>`, `<nav>`, `<main>`) over `<div role="…">`.

### 8. Styling
- Tailwind 4 utility classes only. No inline `style=` except for dynamic values (e.g. progress bar width).
- No global CSS additions outside `app.css`. Component styles go in `<style>` blocks scoped by Svelte.

### 9. Tests
- New `*.svelte.ts` modules and pure helpers in `src/lib/**` should ship a sibling `*.test.ts`.
- For session / tenant / cookie-scope logic, follow the patterns in `session-paths.test.ts`, `cookie-scope.test.ts`, `tenant.test.ts`.

## What NOT to flag
- Use of `any`, `console`, `!` non-null assertions — Biome config disables these rules.
- Anything under `.svelte-kit/`, `build/`, `node_modules/`.
- Older files still using `export let` / `$:` — only enforce runes in new files.

## When suggesting changes
- Quote the file/line and the offending snippet.
- For data-flow issues, draw the SSR → hydration boundary explicitly ("this runs in the browser but the cookie isn't available there — move to `+page.server.ts`").
- Cross-reference `docs/DEPLOYMENT.md` (cookie scope) and `docs/BRAND.md` (naming, casing) where relevant.
