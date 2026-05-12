<section class="relative overflow-hidden">
  <!-- Decorative editorial frame: faint vertical rule columns -->
  <div class="pointer-events-none absolute inset-0 mx-auto max-w-7xl px-8" aria-hidden="true">
    <div class="absolute inset-y-0 left-8 w-px bg-[var(--rule)]"></div>
    <div class="absolute inset-y-0 right-8 w-px bg-[var(--rule)]"></div>
  </div>

  <div class="mx-auto grid max-w-7xl grid-cols-12 gap-8 px-12 pb-24 pt-24">
    <!-- Issue plate -->
    <div class="sl-reveal sl-reveal-1 col-span-12 flex items-center gap-4 text-[var(--ink-mute)]">
      <span class="sl-eyebrow">Vol. I · No. 01</span>
      <span class="h-px w-12 bg-[var(--rule-strong)] sl-rule-anim"></span>
      <span class="sl-mono text-[11px]" style="letter-spacing:0.06em">EST. STEWARDLEDGER · INVITATION-ONLY</span>
      <span class="ml-auto sl-mono text-[11px]" style="letter-spacing:0.06em">
        {new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" })}
      </span>
    </div>

    <!-- Headline column -->
    <div class="sl-reveal sl-reveal-2 col-span-12 mt-10 md:col-span-8">
      <h1 class="sl-display text-[clamp(48px,7.5vw,108px)] font-light leading-[0.95] text-[var(--ink)]">
        The church
        <span class="sl-serif-italic font-light text-[var(--brass-deep)]">finance</span>
        ledger,
        <span class="block">recorded once,</span>
        <span class="block">traceable forever.</span>
      </h1>
    </div>

    <!-- Marginalia / definition -->
    <aside class="sl-reveal sl-reveal-3 col-span-12 mt-10 self-end md:col-span-4 md:mt-32">
      <div class="border-l border-[var(--rule-strong)] pl-5">
        <p class="sl-eyebrow mb-3">Stew·ard·ship</p>
        <p class="sl-display text-[15px] italic leading-relaxed text-[var(--ink-soft)]">
          <span class="sl-mono not-italic" style="font-size:11px;letter-spacing:0.06em">/ˈstjuːədʃɪp/</span>
          &nbsp;the careful and responsible management of something
          entrusted to one's care — a household, a flock, a ledger.
        </p>
      </div>
    </aside>

    <!-- Subhead + CTAs -->
    <div class="sl-reveal sl-reveal-4 col-span-12 mt-16 grid grid-cols-12 gap-8">
      <div class="col-span-12 md:col-span-7">
        <p class="text-[19px] leading-[1.55] text-[var(--ink-soft)]">
          From a single member's giving to a zone's annual partnership —
          <em class="sl-serif-italic text-[var(--ink)]">one ledger</em>, audited end-to-end,
          reportable in seconds. Built for the way ministry actually accounts.
        </p>
        <div class="mt-9 flex flex-wrap items-center gap-4">
          <a href="https://demo.stewardledger.church" class="sl-btn sl-btn-primary">
            Open the demo
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M3 7h8M7.5 3.5L11 7l-3.5 3.5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </a>
          <a href="/login" class="sl-btn sl-btn-ghost">Sign in</a>
          <span class="ml-2 text-[12px] text-[var(--ink-mute)]">
            No card. No trial timer. Just the books.
          </span>
        </div>
      </div>

      <!-- Mini ledger card -->
      <div class="col-span-12 md:col-span-5">
        <div class="sl-card relative overflow-hidden p-6">
          <div class="flex items-center justify-between">
            <span class="sl-eyebrow">Posted · today</span>
            <span class="sl-badge sl-badge-ok">balanced</span>
          </div>
          <div class="mt-5 flex items-baseline justify-between border-b border-dashed border-[var(--rule)] pb-3">
            <span class="text-[13px] text-[var(--ink-mute)]">Sunday close · Chapter NW-04</span>
            <span class="sl-mono sl-num text-[15px] text-[var(--ink)]">£ 4,218.50</span>
          </div>
          <div class="mt-2 flex items-baseline justify-between border-b border-dashed border-[var(--rule)] pb-3">
            <span class="text-[13px] text-[var(--ink-mute)]">Online giving · Stripe</span>
            <span class="sl-mono sl-num text-[15px] text-[var(--ink)]">£ 1,940.00</span>
          </div>
          <div class="mt-2 flex items-baseline justify-between border-b border-dashed border-[var(--rule)] pb-3">
            <span class="text-[13px] text-[var(--ink-mute)]">Bank import · 24 rows</span>
            <span class="sl-mono sl-num text-[15px] text-[var(--ink)]">£ 9,612.07</span>
          </div>
          <div class="mt-5 flex items-baseline justify-between">
            <span class="sl-display text-[15px] italic text-[var(--ink)]">Day total</span>
            <span class="sl-display sl-num text-[28px] font-medium text-[var(--brass-deep)]">£ 15,770.57</span>
          </div>
          <!-- ledger ribbon -->
          <div class="pointer-events-none absolute -right-10 top-6 rotate-45 bg-[var(--brass)] px-12 py-1 sl-mono text-[9px] font-medium uppercase text-[var(--paper)]" style="letter-spacing:0.18em">
            Ledger
          </div>
        </div>
        <p class="mt-3 text-right sl-mono text-[10.5px] text-[var(--ink-mute)]" style="letter-spacing:0.06em">
          — sample close · figures illustrative
        </p>
      </div>
    </div>
  </div>

  <!-- Feature strip -->
  <div class="border-y border-[var(--rule)] bg-[var(--paper-soft)]">
    <div class="mx-auto grid max-w-7xl grid-cols-12 gap-0 px-8">
      {#each [
        { n: "I",   t: "Members & chapters",  d: "One identity per giver across every chapter, zone, and gathering. Merge duplicates without losing history." },
        { n: "II",  t: "Sunday close",        d: "Cash, cheque, online, bank. Submit, approve, post — with an audit trail an auditor would smile at." },
        { n: "III", t: "Reports in seconds",  d: "Statements, ledgers, donor letters. Exported as Excel today, PDF tomorrow, signed end-to-end." },
      ] as f, i (f.n)}
        <div
          class="sl-reveal col-span-12 border-[var(--rule)] px-6 py-10 md:col-span-4 md:px-10"
          class:md:border-l={i !== 0}
          style={`animation-delay:${500 + i * 80}ms`}
        >
          <span class="sl-display text-[36px] italic text-[var(--brass-deep)]">{f.n}.</span>
          <h3 class="mt-3 sl-display text-[22px] text-[var(--ink)]">{f.t}</h3>
          <p class="mt-3 text-[14px] leading-relaxed text-[var(--ink-mute)]">{f.d}</p>
        </div>
      {/each}
    </div>
  </div>

  <!-- Quiet footer note -->
  <div class="mx-auto max-w-7xl px-12 py-16 text-center">
    <p class="sl-display text-[15px] italic text-[var(--ink-mute)]">
      StewardLedger is invitation-only. To onboard a zone, write to
      <a href="mailto:hello@stewardledger.church" class="sl-link not-italic sl-mono" style="font-size:13px">hello@stewardledger.church</a>.
    </p>
    <div class="mx-auto mt-8 h-px w-24 bg-[var(--rule-strong)]"></div>
    <p class="mt-8 sl-mono text-[10.5px] text-[var(--ink-faint)]" style="letter-spacing:0.18em">— FIN —</p>
  </div>
</section>
