import jsPDF from "jspdf";
import html2canvas from "html2canvas";
import { invoke } from "./invoke";

// Item/customer/staff names come from DB data and are interpolated into
// innerHTML to build the PDF-source DOM -- must be escaped, same "never
// trust stored data when it becomes markup" rule as any other
// HTML-injection surface, even though this DOM is local-only and never
// sent anywhere.
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function pdfTableHtml(title: string, headers: string[], rows: string[][]): string {
  const head = headers.map((h) => `<th style="border:1px solid #E4E7EC;padding:6px 8px;background:#F2F4F7;font-size:11px;text-align:start">${escapeHtml(h)}</th>`).join("");
  const body = rows
    .map((r) => `<tr>${r.map((c) => `<td style="border:1px solid #E4E7EC;padding:6px 8px;font-size:11px">${escapeHtml(c)}</td>`).join("")}</tr>`)
    .join("");
  return `
    <h2 style="font-size:14px;font-weight:700;margin:16px 0 8px">${escapeHtml(title)}</h2>
    <table style="width:100%;border-collapse:collapse">
      <thead><tr>${head}</tr></thead>
      <tbody>${body || `<tr><td style="border:1px solid #E4E7EC;padding:6px 8px;font-size:11px;color:#98A2B3" colspan="${headers.length}">لا توجد بيانات</td></tr>`}</tbody>
    </table>
  `;
}

/**
 * Arabic PDF export, done right -- extracted from reports/page.tsx (the
 * page this was originally built and verified for) so every other export
 * button in the app (customers, finance, debt, suppliers -- previously CSV,
 * or missing entirely) uses the exact same proven mechanism instead of each
 * reinventing it.
 *
 * jsPDF's own text renderer has no Arabic shaping/bidi support at all (its
 * default fonts don't even have Arabic glyphs) -- verified previously by
 * generating a PDF with `.html()` and rasterizing it: real Arabic came out
 * as disconnected mojibake, not text. Fixed by calling html2canvas
 * manually and embedding the RESULT AS AN IMAGE via doc.addImage() -- this
 * guarantees jsPDF never touches the Arabic text itself; it's a picture of
 * what the browser's own text engine drew (the same Tajawal rendering
 * already correct everywhere else in this app).
 *
 * Getting the finished PDF to disk does NOT use jsPDF's own `doc.save()`.
 * That method is a blob URL plus a synthetic `<a download>` click -- it
 * depends on a browser's download manager to catch that click, and Tauri's
 * webview has none (the app's CSP also has no `blob:` allowance). Every
 * export button was silently generating a correct PDF in memory and then
 * doing nothing with it. Fixed by handing the raw bytes to `export_pdf_v3`
 * (Rust), which writes them straight to the OS Downloads folder and
 * returns the path -- shown here as a brief on-screen confirmation so the
 * "did it actually work" question has an answer.
 */
export async function exportHtmlToPdf(filename: string, bodyHtml: string, sessionToken: string): Promise<void> {
  await document.fonts.ready; // Tajawal must be loaded before html2canvas captures it

  // Positioned in-flow (not off-screen with a huge negative offset) --
  // html2canvas reliably captures blank/wrong-region content for
  // off-screen-positioned elements. `z-index` keeps it from visually
  // disrupting the page during the brief moment it's attached.
  const container = document.createElement("div");
  container.dir = "rtl";
  container.style.cssText = "position:absolute;top:0;left:0;width:700px;padding:24px;background:#fff;font-family:Tajawal,sans-serif;color:#101828;z-index:9999;";
  container.innerHTML = bodyHtml;
  document.body.appendChild(container);
  const canvas = await html2canvas(container, { scale: 2, backgroundColor: "#ffffff" });
  document.body.removeChild(container);

  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 20;
  const imgWidth = pageWidth - margin * 2;
  const imgHeight = (canvas.height * imgWidth) / canvas.width;
  const imgData = canvas.toDataURL("image/png");
  const usableHeight = pageHeight - margin * 2;

  // Multi-page: slice the tall rendered image across pages if the content
  // is longer than one A4 page. Each page gets the same full-width image,
  // shifted up by one page's worth of content.
  let heightLeft = imgHeight;
  let renderedY = margin;
  doc.addImage(imgData, "PNG", margin, renderedY, imgWidth, imgHeight);
  heightLeft -= usableHeight;
  while (heightLeft > 0) {
    renderedY = margin - (imgHeight - heightLeft);
    doc.addPage();
    doc.addImage(imgData, "PNG", margin, renderedY, imgWidth, imgHeight);
    heightLeft -= usableHeight;
  }

  const bytes = Array.from(new Uint8Array(doc.output("arraybuffer")));
  const savedPath = await invoke<string>("export_pdf_v3", { sessionToken, filename, bytes });
  showSavedToast(savedPath);
}

function showSavedToast(path: string): void {
  const toast = document.createElement("div");
  toast.dir = "rtl";
  toast.style.cssText =
    "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#101828;color:#fff;padding:10px 18px;border-radius:12px;font-family:Tajawal,sans-serif;font-size:13px;z-index:99999;box-shadow:0 4px 12px rgba(0,0,0,.2);max-width:90vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
  toast.textContent = `تم الحفظ في: ${path}`;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}
