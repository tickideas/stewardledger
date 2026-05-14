// packages/web/src/lib/qr.ts
// Tiny wrapper around the `qrcode` package that returns a data URL.
// Lives in its own module so the Security page can mock / replace it in
// tests without pulling the QR encoder into the unit-test bundle.
// RELEVANT FILES: packages/web/src/routes/account/security/+page.svelte

import QRCode from "qrcode";

/**
 * Render a QR-encoded payload as an inline PNG data URL. The Better Auth
 * two-factor enable response returns an `otpauth://totp/...` URI; we feed
 * that URI in here and bind the returned data URL to an `<img src>`.
 *
 * The QR library is a deps-only dependency (~6KB in the bundle); the data
 * URL is the friendliest output for Svelte templating without needing a
 * canvas ref. Margin = 1 keeps the quiet zone tight against the authenticator
 * app's "scan code" frame.
 */
export async function renderQrDataUrl(payload: string): Promise<string> {
  return QRCode.toDataURL(payload, {
    errorCorrectionLevel: "M",
    margin: 1,
    scale: 6,
  });
}
