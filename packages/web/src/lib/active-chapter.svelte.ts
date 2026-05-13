// packages/web/src/lib/active-chapter.svelte.ts
// Shared store for the church-admin surface's active chapter. Mirrors the
// shape of `session` in `session.svelte.ts`: a single module-level rune
// that every consumer (layout switcher, page-level `useActiveChapter()`)
// reads and writes. The localStorage value is the durable record across
// reloads + tabs; the in-memory rune is the source of truth within a tab.

import { ACTIVE_CHAPTER_KEY, session } from "$lib/session.svelte";

export type ActiveChapter = { id: string; name: string } | null;
export type ChapterChoice = { id: string; name: string };

/**
 * The one true active-chapter id for the current tab. `null` until the
 * shell hydrates it from localStorage (or assigns a default).
 */
export const activeChapter = $state<{ id: string | null }>({ id: null });
export const activeChapterChoices = $state<{ items: ChapterChoice[] }>({ items: [] });

let storageListenerInstalled = false;

/**
 * Idempotently hydrate `activeChapter.id` from localStorage. Safe to call
 * from any layout/page effect. Installs a cross-tab `storage` listener the
 * first time it runs so a chapter switch in tab A propagates to tab B.
 */
export function hydrateActiveChapter(): void {
  if (typeof localStorage === "undefined") return;
  if (activeChapter.id === null) {
    activeChapter.id = localStorage.getItem(ACTIVE_CHAPTER_KEY);
  }
  if (!storageListenerInstalled && typeof window !== "undefined") {
    window.addEventListener("storage", (ev) => {
      if (ev.key === ACTIVE_CHAPTER_KEY) activeChapter.id = ev.newValue;
    });
    storageListenerInstalled = true;
  }
}

/**
 * Set the active chapter and persist it. Same-tab consumers see the change
 * via the shared `$state`; other tabs receive it via the `storage` event.
 * Pass `null` to clear.
 */
export function setActiveChapter(id: string | null): void {
  activeChapter.id = id;
  if (typeof localStorage === "undefined") return;
  if (id) localStorage.setItem(ACTIVE_CHAPTER_KEY, id);
  else localStorage.removeItem(ACTIVE_CHAPTER_KEY);
}

export function setActiveChapterChoices(items: ChapterChoice[]): void {
  activeChapterChoices.items = items;
}

/**
 * Reactive accessor for the resolved active chapter ({ id, name }). Returns
 * `null` when no chapter is selected or when the stored id no longer
 * matches any of the user's bindings (e.g. role revoked, chapter deleted).
 *
 * Use:
 *   const chapter = useActiveChapter();
 *   $effect(() => { if (chapter()) refresh(chapter()!.id); });
 *
 * The function form gives callers a fresh read on each access; Svelte 5
 * runes track that as a dependency, so reactivity Just Works.
 */
export function useActiveChapter(): () => ActiveChapter {
  return () => {
    const id = activeChapter.id;
    if (!id) return null;
    const s = session.current;
    if (s.status !== "authenticated") return null;
    const zone = s.zones.find((z) => z.slug === s.activeZoneSlug);
    const binding = zone?.chapterRoles.find((r) => r.chapterId === id);
    if (!binding) {
      const choice = activeChapterChoices.items.find((c) => c.id === id);
      return choice ? { id: choice.id, name: choice.name } : null;
    }
    return { id: binding.chapterId, name: binding.chapterName };
  };
}
