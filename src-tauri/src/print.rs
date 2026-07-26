//! Real OS-level printing (2026-07-26 audit fix).
//!
//! The USB printing path used to rely entirely on browser WebUSB
//! (`navigator.usb`, called from `printer.ts`) -- which silently never
//! worked, because Tauri's embedded webview (WebView2 on Windows,
//! WebKitGTK on Linux) does not implement WebUSB at all. A cashier
//! plugging in a USB thermal printer and pressing "print" got nothing:
//! no error, no paper, just a `.bin` file quietly downloaded to disk.
//!
//! This replaces that path with the OS's own print spooler (winspool on
//! Windows, CUPS on Linux/macOS, via the `printers` crate), sending the
//! exact same ESC/POS byte buffer `printer.ts` already builds as a RAW
//! print job -- RAW bypasses the driver's own text/GDI formatting and
//! writes the bytes straight to the device, which is exactly what ESC/POS
//! commands need. The frontend's byte-generation logic (`printer.ts`) is
//! untouched; only "how the bytes reach the physical device" changes.
//!
//! Network printers were already working (raw `fetch` to an IP:port) and
//! are unaffected by this file.

use printers::common::base::job::PrinterJobOptions;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemPrinterV3 {
    /// The OS-registered queue name -- what must be persisted (in
    /// `printers.system_printer_name`) and passed back to
    /// `print_raw_bytes_v3` later. NOT the same as `name`, which is a
    /// display label that can differ from the actual queue name.
    pub system_name: String,
    pub name: String,
    pub is_default: bool,
}

/// Lists real, OS-installed printers -- what Settings' USB printer picker
/// should show instead of a WebUSB device chooser (which never found
/// anything in the actual desktop app). No auth needed: this only reads
/// this local machine's own OS printer list, no tenant/branch data.
#[tauri::command]
pub fn list_system_printers_v3() -> Vec<SystemPrinterV3> {
    printers::get_printers()
        .into_iter()
        .map(|p| SystemPrinterV3 { system_name: p.system_name, name: p.name, is_default: p.is_default })
        .collect()
}

/// Sends a raw byte buffer (an ESC/POS receipt/kitchen-ticket/drawer-pulse
/// command, already built by `printer.ts`) to a named OS printer queue as
/// a RAW job. This is the actual hardware I/O for USB printers -- the
/// piece that was entirely missing before, since `printer.ts` had no way
/// to reach real hardware except through WebUSB.
#[tauri::command]
pub fn print_raw_bytes_v3(printer_name: String, data: Vec<u8>) -> Result<(), String> {
    let printer = printers::get_printer_by_name(&printer_name)
        .ok_or_else(|| format!("no such system printer: \"{printer_name}\" -- it may have been unplugged or renamed"))?;
    printer.print(&data, PrinterJobOptions::none()).map(|_job_id| ()).map_err(|e| e.message)
}
