<script lang="ts">
  // Compact diagnostic that fires POST /api/admin/diagnostics/email-test.
  // Surfaces the structured failure envelope from the API so operators can
  // distinguish "useSend not configured" from "domain not verified" without
  // tailing logs. Surfaces success quietly — the operator's inbox is the
  // real confirmation.

  import { api, ApiError } from "$lib/api";

  type SuccessResult = {
    status: "sent";
    transport: "usesend" | "dev-log";
    endpoint: string | null;
    to: string;
    sentAt: string;
  };

  type FailureResult = {
    status: "failed";
    transport: "usesend" | "dev-log";
    reason: "missing-config" | "missing-from" | "network" | "http";
    detail: string | null;
    httpStatus: number | null;
    endpoint: string | null;
    to: string;
  };

  type EmailTestResult = SuccessResult | FailureResult;

  let recipient = $state("");
  let submitting = $state(false);
  let result = $state<EmailTestResult | null>(null);
  let error = $state<string | null>(null);
  let open = $state(false);

  async function runTest() {
    submitting = true;
    error = null;
    result = null;
    try {
      const body: Record<string, string> = {};
      const trimmed = recipient.trim();
      if (trimmed.length > 0) body.to = trimmed;
      result = await api.post<EmailTestResult>("/api/admin/diagnostics/email-test", body);
    } catch (err) {
      error = err instanceof ApiError ? `${err.code}: ${err.message}` : "Request failed.";
    } finally {
      submitting = false;
    }
  }

  const reasonHint: Record<FailureResult["reason"], string> = {
    "missing-config": "USESEND_API_KEY or USESEND_API_URL is not set in the API environment.",
    "missing-from": "USESEND_FROM is not set. Configure a verified sender address.",
    network: "Could not reach the useSend instance. Check DNS, TLS, and firewall rules.",
    http: "useSend rejected the request. Check the API key and that the sender domain is verified inside useSend.",
  };
</script>

<details
  bind:open
  class="mt-6 border border-[var(--rule)] bg-[var(--card)] open:bg-[var(--paper-soft)]"
>
  <summary class="flex cursor-pointer items-center justify-between gap-3 px-4 py-3 text-[12.5px] text-[var(--ink-soft)]">
    <span class="sl-eyebrow">Outbound email · diagnostic</span>
    <span class="sl-mono text-[10.5px] text-[var(--ink-mute)]" style="letter-spacing:0.06em">
      {open ? "HIDE" : "TEST useSend"}
    </span>
  </summary>

  <div class="border-t border-[var(--rule)] px-4 py-4">
    <p class="text-[12.5px] leading-relaxed text-[var(--ink-mute)]">
      Sends a real test message through the configured useSend transport. Defaults to your own
      address; override below to send to a specific mailbox.
    </p>

    <div class="mt-3 flex flex-wrap items-center gap-2">
      <input
        type="email"
        bind:value={recipient}
        placeholder="leave blank to send to yourself"
        class="sl-input w-72"
        autocomplete="off"
        spellcheck="false"
      />
      <button
        type="button"
        onclick={runTest}
        disabled={submitting}
        class="sl-btn sl-btn-primary"
      >
        {submitting ? "Sending…" : "Send test"}
      </button>
    </div>

    {#if error}
      <p class="mt-3 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-[12.5px] text-[var(--bad)]">
        {error}
      </p>
    {/if}

    {#if result?.status === "sent"}
      <div class="mt-3 border-l-2 border-[var(--ok)] bg-[var(--ok-soft)] px-3 py-3 text-[12.5px] text-[var(--ink-soft)]">
        <div class="text-[var(--ink)]">
          Sent to <code class="sl-mono">{result.to}</code> via
          <code class="sl-mono">{result.transport}</code>.
        </div>
        {#if result.transport === "dev-log"}
          <div class="mt-1 text-[var(--warn)]">
            Note: dev-log transport means no email actually left the server. Set
            <code class="sl-mono">USESEND_API_KEY</code>,
            <code class="sl-mono">USESEND_API_URL</code>, and
            <code class="sl-mono">USESEND_FROM</code> in the API environment.
          </div>
        {:else}
          <div class="mt-1 text-[var(--ink-mute)]">
            Check the inbox. Delivery may take a few seconds depending on the upstream MX.
          </div>
        {/if}
        {#if result.endpoint}
          <div class="mt-1 sl-mono text-[10.5px] text-[var(--ink-mute)]">
            POST {result.endpoint}
          </div>
        {/if}
      </div>
    {:else if result?.status === "failed"}
      <div class="mt-3 border-l-2 border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-3 text-[12.5px] text-[var(--ink-soft)]">
        <div class="text-[var(--bad)]">
          Failed · <code class="sl-mono">{result.reason}</code>
          {#if result.httpStatus}
            <span class="sl-mono">(HTTP {result.httpStatus})</span>
          {/if}
        </div>
        <div class="mt-1 text-[var(--ink-soft)]">{reasonHint[result.reason]}</div>
        {#if result.detail}
          <pre class="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-words border border-[var(--rule)] bg-[var(--paper)] px-2 py-1.5 sl-mono text-[11px] text-[var(--ink-mute)]">{result.detail}</pre>
        {/if}
        {#if result.endpoint}
          <div class="mt-1 sl-mono text-[10.5px] text-[var(--ink-mute)]">
            POST {result.endpoint}
          </div>
        {/if}
      </div>
    {/if}
  </div>
</details>
