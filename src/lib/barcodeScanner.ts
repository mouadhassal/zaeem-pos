let scanBuffer = "";
let scanTimeout: ReturnType<typeof setTimeout> | null = null;
const SCAN_INTERVAL = 50;
let enabled = false;
type ScanCallback = (code: string) => void;
let onScan: ScanCallback | null = null;

// 2026-08-25 QA re-audit ("weird errors" report): this listener is
// attached to `window` for the entire time the POS page is mounted (see
// pos/page.tsx's enableBarcodeScanner call), with no awareness of what's
// currently focused -- so typing into ANY text input anywhere on that
// screen (a debtor search, the shift-open amount field, any future modal
// field) got captured character-by-character into the scan buffer too,
// and after a short pause fired onScan with whatever was just typed,
// producing a spurious "لم يتم العثور على صنف بهذا الباركود" toast that
// had nothing to do with a real scan. Confirmed live: typing a starting-
// cash amount into the new shift-open modal reliably triggered this.
// Real barcode scanners emulate rapid keystrokes with no real user
// intent to be typing into a field at that moment -- the correct
// disambiguation is simply: if a text input/textarea/contentEditable
// currently has focus, this keystroke is real typing, not a scan.
function isTypingIntoAField(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || (el as HTMLElement).isContentEditable;
}

function handleKeyDown(e: KeyboardEvent): void {
  if (!enabled) return;

  if (e.key === "F12") {
    e.preventDefault();
    return;
  }

  // Only the scan-buffer logic below needs to back off while a real text
  // field has focus -- F12-blocking above is a separate concern (devtools
  // access) that must still apply regardless of what's focused.
  if (isTypingIntoAField()) return;

  if (e.key === "Enter" && scanBuffer.length > 0) {
    onScan?.(scanBuffer);
    scanBuffer = "";
    if (scanTimeout) clearTimeout(scanTimeout);
    scanTimeout = null;
    return;
  }

  if (e.key.length === 1) {
    scanBuffer += e.key;
    if (scanTimeout) clearTimeout(scanTimeout);
    scanTimeout = setTimeout(() => {
      if (scanBuffer.length > 0) {
        onScan?.(scanBuffer);
      }
      scanBuffer = "";
    }, SCAN_INTERVAL);
  }
}

export function enableBarcodeScanner(callback: ScanCallback): void {
  if (enabled) return;
  enabled = true;
  onScan = callback;
  window.addEventListener("keydown", handleKeyDown);
}

export function disableBarcodeScanner(): void {
  enabled = false;
  onScan = null;
  window.removeEventListener("keydown", handleKeyDown);
  scanBuffer = "";
  if (scanTimeout) clearTimeout(scanTimeout);
  scanTimeout = null;
}

export function setScannerCallback(callback: ScanCallback | null): void {
  onScan = callback;
}
