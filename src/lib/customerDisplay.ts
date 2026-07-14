interface VFDDisplayConfig {
  port: string;
  baud: number;
}

let displayConfig: VFDDisplayConfig | null = null;
let displayWriter: WritableStreamDefaultWriter | null = null;

export async function initCustomerDisplay(config: VFDDisplayConfig): Promise<void> {
  displayConfig = config;

  if ("serial" in navigator) {
    try {
      const port = await (navigator as any).serial.requestPort();
      await port.open({ baudRate: config.baud });
      displayWriter = port.writable.getWriter();
    } catch {
      // Serial not available
    }
  }
}

export function setCustomerDisplayConfig(config: VFDDisplayConfig): void {
  displayConfig = config;
}

export function updateCustomerDisplay(message: string): void {
  if (!displayConfig) return;

  const vfd16 = new TextEncoder().encode(message.slice(0, 16).padEnd(16, " "));
  const clearCmd = new Uint8Array([0x0c]);
  const fullCmd = new Uint8Array([...clearCmd, ...vfd16]);

  if (displayWriter) {
    try {
      displayWriter.write(fullCmd);
    } catch {
      // Display offline
    }
  }
}

export function showCustomerWelcome(): void {
  updateCustomerDisplay("مرحباً بكم");
}

export function showCustomerTotal(cents: number): void {
  const total = new Intl.NumberFormat("ar-SA", {
    style: "currency",
    currency: "SAR",
  }).format(cents / 100);
  updateCustomerDisplay(`المجموع: ${total}`);
}

export async function closeCustomerDisplay(): Promise<void> {
  if (displayWriter) {
    try {
      await displayWriter.close();
    } catch {
      // ignore
    }
    displayWriter = null;
  }
}
