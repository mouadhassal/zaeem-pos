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
//! Network printers (2026-09-23 fix): these used to be "printed" with a
//! webview `fetch` POST to IP:9100. Thermal printers speak raw TCP
//! (JetDirect), not HTTP -- the non-simple POST triggered a CORS preflight
//! the printer never answers, so no kitchen ticket ever arrived.
//! `print_network_raw_v3` writes the ESC/POS bytes straight to the socket.

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

/// Sends a raw ESC/POS byte buffer to a network thermal printer over a
/// plain TCP socket (port 9100 "raw"/JetDirect -- what every LAN thermal
/// printer listens on). Short timeouts so an unplugged kitchen printer
/// fails fast into the retry queue instead of freezing the till.
#[tauri::command]
pub async fn print_network_raw_v3(ip_address: String, port: u16, data: Vec<u8>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || send_raw_tcp(&ip_address, port, &data))
        .await
        .map_err(|e| e.to_string())?
}

fn send_raw_tcp(host: &str, port: u16, data: &[u8]) -> Result<(), String> {
    use std::io::Write;
    use std::net::{TcpStream, ToSocketAddrs};
    use std::time::Duration;

    let port = if port == 0 { 9100 } else { port };
    let addr = (host.trim(), port)
        .to_socket_addrs()
        .map_err(|e| format!("عنوان الطابعة غير صالح: {host}:{port} ({e})"))?
        .next()
        .ok_or_else(|| format!("عنوان الطابعة غير صالح: {host}:{port}"))?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(3))
        .map_err(|e| format!("تعذر الاتصال بالطابعة {host}:{port} ({e})"))?;
    stream.set_write_timeout(Some(Duration::from_secs(5))).map_err(|e| e.to_string())?;
    stream.write_all(data).map_err(|e| format!("انقطع الاتصال بالطابعة أثناء الطباعة ({e})"))?;
    stream.flush().map_err(|e| e.to_string())?;
    let _ = stream.shutdown(std::net::Shutdown::Write);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::send_raw_tcp;
    use std::io::Read;
    use std::net::TcpListener;

    #[test]
    fn network_print_writes_exact_bytes_over_raw_tcp() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let reader = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let mut got = Vec::new();
            sock.read_to_end(&mut got).unwrap();
            got
        });
        let job = vec![0x1b, 0x40, b'o', b'k', 0x1d, 0x56, 0x00];
        send_raw_tcp("127.0.0.1", port, &job).unwrap();
        assert_eq!(reader.join().unwrap(), job, "the printer must receive the ESC/POS bytes verbatim, no HTTP framing");
    }

    #[test]
    fn network_print_fails_fast_when_printer_is_off() {
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port(); // bound then dropped: nothing listens
        let started = std::time::Instant::now();
        assert!(send_raw_tcp("127.0.0.1", port, b"x").is_err());
        assert!(started.elapsed().as_secs() < 5);
    }
}
