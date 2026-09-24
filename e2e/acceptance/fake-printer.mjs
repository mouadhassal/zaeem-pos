// A fake ESC/POS network printer (raw TCP 9100, like real thermal printers).
// Each connection's bytes are saved to .e2e-pos/prints/<n>.bin.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { ROOT } from "./harness.mjs";

const port = Number(process.env.PRINTER_PORT ?? 9100);
const dir = path.join(ROOT, ".e2e-pos", process.env.PRINT_DIR ?? "prints");
fs.mkdirSync(dir, { recursive: true });
let n = fs.readdirSync(dir).length;
net
  .createServer((sock) => {
    const chunks = [];
    sock.on("data", (c) => chunks.push(c));
    sock.on("end", () => {
      const f = path.join(dir, `${String(++n).padStart(3, "0")}.bin`);
      fs.writeFileSync(f, Buffer.concat(chunks));
      console.log(`print job -> ${f} (${Buffer.concat(chunks).length} bytes)`);
    });
    sock.on("error", () => {});
  })
  .listen(port, "127.0.0.1", () => console.log(`fake printer on ${port} -> ${dir}`));
