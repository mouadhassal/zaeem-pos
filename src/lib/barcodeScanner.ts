let scanBuffer = "";
let scanTimeout: ReturnType<typeof setTimeout> | null = null;
const SCAN_INTERVAL = 50;
let enabled = false;
type ScanCallback = (code: string) => void;
let onScan: ScanCallback | null = null;

function handleKeyDown(e: KeyboardEvent): void {
  if (!enabled) return;

  if (e.key === "F12") {
    e.preventDefault();
    return;
  }

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
