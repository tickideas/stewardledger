<!-- packages/web/src/routes/zone/members/member-bulk-add.svelte -->
<!-- Imports members from a CSV file using the existing tenant member create API. -->
<!-- Exists so zones can add a church roster in bulk while preserving row-level validation feedback. -->
<!-- RELEVANT FILES: packages/web/src/routes/zone/members/+page.svelte, packages/api/src/routes/tenant-members.ts, packages/web/src/routes/zone/members/member-profile-fields.svelte -->

<script lang="ts">
  import { api, ApiError } from "$lib/api";

  type Chapter = { id: string; name: string };
  type Lookup = { id: string; name: string; isActive: boolean; gender?: string | null };

  type CsvMember = {
    rowNumber: number;
    title: string;
    firstName: string;
    lastName: string;
    email: string;
    mobile: string;
    chapter: string;
  };

  let {
    chapters,
    titles,
    onComplete,
    onClose,
  }: {
    chapters: Chapter[];
    titles: Lookup[];
    onComplete: () => Promise<void> | void;
    onClose: () => void;
  } = $props();

  let fileName = $state("");
  let parsed = $state<CsvMember[]>([]);
  let errors = $state<string[]>([]);
  let importing = $state(false);
  let importedCount = $state(0);
  let importError = $state<string | null>(null);

  const MAX_CSV_BYTES = 1_000_000;
  const MAX_CSV_ROWS = 500;

  const sampleCsvHref = $derived.by(() => {
    const chapterName = chapters[0]?.name ?? "Main Church";
    const sample = [
      ["title", "first_name", "last_name", "email", "mobile", "chapter"],
      ["Mr", "John", "Mensah", "john.mensah@example.com", "+447700900001", chapterName],
      ["Mrs", "Ama", "Mensah", "ama.mensah@example.com", "+447700900002", chapterName],
    ];
    return `data:text/csv;charset=utf-8,${encodeURIComponent(toCsv(sample))}`;
  });

  const titleByName = $derived.by(() => {
    const map = new Map<string, Lookup>();
    for (const title of titles.filter((t) => t.isActive)) {
      map.set(normalize(title.name), title);
    }
    return map;
  });

  const chapterByName = $derived.by(() => {
    const map = new Map<string, Chapter>();
    for (const chapter of chapters) {
      map.set(normalize(chapter.name), chapter);
    }
    return map;
  });

  function normalize(value: string): string {
    return value.trim().toLowerCase();
  }

  function toCsv(rows: string[][]): string {
    return rows
      .map((row) =>
        row
          .map((cell) => {
            const escaped = cell.replaceAll("\"", "\"\"");
            return /[",\n\r]/.test(escaped) ? `"${escaped}"` : escaped;
          })
          .join(","),
      )
      .join("\n");
  }

  function parseCsv(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = "";
    let inQuotes = false;
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      const next = text[i + 1];
      if (char === "\"" && inQuotes && next === "\"") {
        cell += "\"";
        i += 1;
      } else if (char === "\"") {
        inQuotes = !inQuotes;
      } else if (char === "," && !inQuotes) {
        row.push(cell);
        cell = "";
      } else if ((char === "\n" || char === "\r") && !inQuotes) {
        if (char === "\r" && next === "\n") i += 1;
        row.push(cell);
        if (row.some((value) => value.trim() !== "")) rows.push(row);
        row = [];
        cell = "";
      } else {
        cell += char;
      }
    }
    row.push(cell);
    if (row.some((value) => value.trim() !== "")) rows.push(row);
    return rows;
  }

  function parseMembers(text: string): { items: CsvMember[]; errors: string[] } {
    const rows = parseCsv(text);
    if (rows.length === 0) return { items: [], errors: ["The CSV file is empty."] };

    const headers = rows[0].map((h) => normalize(h).replaceAll(" ", "_"));
    const required = ["first_name"];
    const missing = required.filter((field) => !headers.includes(field));
    if (missing.length > 0) {
      return { items: [], errors: [`Missing required column: ${missing.join(", ")}.`] };
    }

    const index = (name: string) => headers.indexOf(name);
    const at = (row: string[], name: string) => {
      const idx = index(name);
      return idx >= 0 ? (row[idx] ?? "").trim() : "";
    };

    const nextItems: CsvMember[] = [];
    const nextErrors: string[] = [];
    for (const [offset, row] of rows.slice(1).entries()) {
      const rowNumber = offset + 2;
      const item: CsvMember = {
        rowNumber,
        title: at(row, "title"),
        firstName: at(row, "first_name"),
        lastName: at(row, "last_name"),
        email: at(row, "email"),
        mobile: at(row, "mobile"),
        chapter: at(row, "chapter"),
      };
      if (!item.firstName) nextErrors.push(`Row ${rowNumber}: first_name is required.`);
      if (item.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item.email)) {
        nextErrors.push(`Row ${rowNumber}: email is not valid.`);
      }
      if (item.title && !titleByName.get(normalize(item.title))) {
        nextErrors.push(`Row ${rowNumber}: title "${item.title}" does not match an active title.`);
      }
      if (item.chapter && !chapterByName.get(normalize(item.chapter))) {
        nextErrors.push(`Row ${rowNumber}: chapter "${item.chapter}" does not match a chapter.`);
      }
      nextItems.push(item);
    }
    return { items: nextItems, errors: nextErrors };
  }

  async function handleFile(e: Event) {
    importedCount = 0;
    importError = null;
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    fileName = file?.name ?? "";
    parsed = [];
    errors = [];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".csv")) {
      errors = ["Please upload a .csv file."];
      return;
    }
    if (file.size > MAX_CSV_BYTES) {
      errors = ["CSV files must be 1 MB or smaller."];
      return;
    }
    const result = parseMembers(await file.text());
    if (result.items.length > MAX_CSV_ROWS) {
      errors = [`Upload ${MAX_CSV_ROWS} members or fewer at a time.`];
      return;
    }
    parsed = result.items;
    errors = result.errors;
  }

  async function importMembers() {
    if (errors.length > 0 || parsed.length === 0) return;
    importing = true;
    importError = null;
    importedCount = 0;
    try {
      for (const row of [...parsed]) {
        const title = row.title ? titleByName.get(normalize(row.title)) : null;
        const chapter = row.chapter ? chapterByName.get(normalize(row.chapter)) : null;
        try {
          await api.post("/api/tenant/members", {
            titleId: title?.id ?? undefined,
            firstName: row.firstName,
            lastName: row.lastName || undefined,
            email: row.email || undefined,
            mobile: row.mobile || undefined,
            chapterId: chapter?.id ?? undefined,
          });
        } catch (err) {
          const message = err instanceof ApiError ? err.message : "Could not import member.";
          importError = `Row ${row.rowNumber}: ${message}`;
          return;
        }
        importedCount += 1;
        parsed = parsed.filter((item) => item.rowNumber !== row.rowNumber);
      }
      fileName = "";
      await onComplete();
    } catch (err) {
      importError = err instanceof ApiError ? err.message : "Could not import members.";
    } finally {
      importing = false;
    }
  }
</script>

<section class="sl-reveal sl-card-warm mt-6 p-6">
  <div class="flex flex-wrap items-start justify-between gap-4">
    <div>
      <span class="sl-eyebrow">Bulk member add</span>
      <h2 class="mt-2 sl-display text-[28px] leading-tight text-[var(--ink)]">
        Upload a <span class="sl-serif-italic font-light text-[var(--brass-deep)]">CSV roster</span>
      </h2>
      <p class="mt-2 max-w-2xl text-[13px] leading-relaxed text-[var(--ink-mute)]">
        Use one row per member. Titles and chapters are matched after trimming spaces and ignoring case;
        download the sample file to keep the format aligned. Uploads are limited to {MAX_CSV_ROWS} rows
        and 1 MB.
      </p>
    </div>
    <button type="button" class="sl-btn sl-btn-ghost" onclick={onClose}>Close</button>
  </div>

  <div class="mt-5 flex flex-wrap items-center gap-3">
    <a href={sampleCsvHref} download="stewardledger-members-sample.csv" class="sl-btn sl-btn-ghost">
      Download sample CSV
    </a>
    <label class="sl-btn sl-btn-primary">
      Choose CSV
      <input type="file" accept=".csv,text/csv" class="sr-only" onchange={handleFile} />
    </label>
    {#if fileName}
      <span class="text-[13px] text-[var(--ink-mute)]">{fileName}</span>
    {/if}
  </div>

  <div class="mt-4 rounded-[3px] border border-[var(--rule)] bg-[var(--card)] px-4 py-3">
    <div class="sl-eyebrow" style="font-size:10px">Supported columns</div>
    <p class="mt-1 text-[13px] text-[var(--ink-mute)]">
      <span class="sl-mono">title, first_name, last_name, email, mobile, chapter</span>
    </p>
    <p class="mt-1 text-[12px] text-[var(--ink-mute)]">
      Only <span class="sl-mono">first_name</span> is required.
    </p>
  </div>

  {#if errors.length > 0}
    <div class="mt-4 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">
      {#each errors as error}
        <div>{error}</div>
      {/each}
    </div>
  {/if}
  {#if importError}
    <p class="mt-4 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[13px] text-[var(--bad)]">{importError}</p>
  {/if}
  {#if importedCount > 0}
    <p class="mt-4 border-l-2 border-[var(--ok)] bg-[var(--ok-soft)] px-3 py-2 text-[13px] text-[var(--ok)]">
      Imported {importedCount} {importedCount === 1 ? "member" : "members"}.
    </p>
  {/if}

  {#if parsed.length > 0}
    <div class="mt-5">
      <div class="mb-2 flex items-center justify-between">
        <span class="sl-eyebrow">Preview</span>
        <span class="sl-mono text-[10.5px] text-[var(--ink-mute)]" style="letter-spacing:0.06em">{parsed.length} rows</span>
      </div>
      <div class="sl-card max-h-72 overflow-auto">
        <table class="sl-table">
          <thead>
            <tr>
              <th>Title</th>
              <th>First name</th>
              <th>Last name</th>
              <th>Email</th>
              <th>Chapter</th>
            </tr>
          </thead>
          <tbody>
            {#each parsed as row (row.rowNumber)}
              <tr>
                <td>{row.title || "—"}</td>
                <td>{row.firstName}</td>
                <td>{row.lastName || "—"}</td>
                <td>{row.email || "—"}</td>
                <td>{row.chapter || "—"}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <button type="button" class="sl-btn sl-btn-primary mt-4" disabled={importing || errors.length > 0} onclick={importMembers}>
        {importing ? "Importing..." : `Import ${parsed.length} ${parsed.length === 1 ? "member" : "members"}`}
      </button>
    </div>
  {/if}
</section>
