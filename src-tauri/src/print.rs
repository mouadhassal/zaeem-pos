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

/// "Windows driver" print mode: draws an already-rendered 1-bit receipt
/// image through the printer's own Windows driver (GDI), so the driver
/// speaks whatever language its printer needs. For printers that print
/// our ESC/POS bytes as garbage (no `GS v 0` support, or not an ESC/POS
/// printer at all). `bitmap` = rows of `ceil(width/8)` bytes, MSB first,
/// 1 = black -- the same packing `canvasToEscPosRaster` uses. Printed at
/// its real paper width (`paper_width_mm`), split across pages when the
/// driver's page is shorter than the receipt.
#[tauri::command]
pub async fn print_image_driver_v3(printer_name: String, width: u32, height: u32, bitmap: Vec<u8>, paper_width_mm: u32) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || gdi::print_bitmap(&printer_name, width, height, &bitmap, paper_width_mm))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(windows)]
pub mod gdi {
    use windows_sys::Win32::Graphics::Gdi::{
        CreateDCW, DeleteDC, GetDeviceCaps, StretchDIBits, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HORZRES,
        LOGPIXELSX, RGBQUAD, SRCCOPY, VERTRES,
    };
    use windows_sys::Win32::Storage::Xps::{AbortDoc, EndDoc, EndPage, StartDocW, StartPage, DOCINFOW};

    #[repr(C)]
    struct MonoBitmapInfo {
        header: BITMAPINFOHEADER,
        colors: [RGBQUAD; 2],
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn print_bitmap(printer: &str, width: u32, height: u32, bitmap: &[u8], paper_width_mm: u32) -> Result<(), String> {
        print_bitmap_to(printer, width, height, bitmap, paper_width_mm, None)
    }

    /// `output`: spool to this file instead of the device (used by the
    /// test_print_driver tool with "Microsoft Print to PDF").
    pub fn print_bitmap_to(printer: &str, width: u32, height: u32, bitmap: &[u8], paper_width_mm: u32, output: Option<&str>) -> Result<(), String> {
        let src_stride = width.div_ceil(8) as usize;
        if width == 0 || height == 0 || bitmap.len() < src_stride * height as usize {
            return Err("receipt image is empty or truncated".into());
        }
        // DIB rows are DWORD-aligned; palette index 1 = black to match our packing.
        let dib_stride = src_stride.div_ceil(4) * 4;
        let mut dib = vec![0u8; dib_stride * height as usize];
        for y in 0..height as usize {
            dib[y * dib_stride..y * dib_stride + src_stride].copy_from_slice(&bitmap[y * src_stride..(y + 1) * src_stride]);
        }

        unsafe {
            let driver = wide("WINSPOOL");
            let device = wide(printer);
            let hdc = CreateDCW(driver.as_ptr(), device.as_ptr(), std::ptr::null(), std::ptr::null());
            if hdc.is_null() {
                return Err(format!("could not open printer \"{printer}\" through its Windows driver"));
            }
            let page_w = GetDeviceCaps(hdc, HORZRES as i32).max(1);
            let page_h = GetDeviceCaps(hdc, VERTRES as i32).max(1);
            let dpi = GetDeviceCaps(hdc, LOGPIXELSX as i32).max(1);
            // Real paper width (58/80 mm), never wider than the printable page.
            let dest_w = ((paper_width_mm.max(40) as f64 / 25.4 * dpi as f64) as i32).min(page_w).max(1);
            let scale = dest_w as f64 / width as f64;
            let rows_per_page = ((page_h as f64 / scale) as u32).max(1);

            let doc_name = wide("WENZDES POS");
            let out_path = output.map(wide);
            let doc = DOCINFOW {
                cbSize: std::mem::size_of::<DOCINFOW>() as i32,
                lpszDocName: doc_name.as_ptr(),
                lpszOutput: out_path.as_ref().map_or(std::ptr::null(), |w| w.as_ptr()),
                lpszDatatype: std::ptr::null(),
                fwType: 0,
            };
            if StartDocW(hdc, &doc) <= 0 {
                DeleteDC(hdc);
                return Err(format!("printer \"{printer}\" refused the print job"));
            }

            let mut row = 0u32;
            while row < height {
                let rows = rows_per_page.min(height - row);
                if StartPage(hdc) <= 0 {
                    AbortDoc(hdc);
                    DeleteDC(hdc);
                    return Err("printer driver refused a page".into());
                }
                let info = MonoBitmapInfo {
                    header: BITMAPINFOHEADER {
                        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                        biWidth: width as i32,
                        biHeight: -(rows as i32), // top-down
                        biPlanes: 1,
                        biBitCount: 1,
                        biCompression: BI_RGB,
                        biSizeImage: 0,
                        biXPelsPerMeter: 0,
                        biYPelsPerMeter: 0,
                        biClrUsed: 2,
                        biClrImportant: 2,
                    },
                    colors: [
                        RGBQUAD { rgbBlue: 255, rgbGreen: 255, rgbRed: 255, rgbReserved: 0 },
                        RGBQUAD { rgbBlue: 0, rgbGreen: 0, rgbRed: 0, rgbReserved: 0 },
                    ],
                };
                let dest_h = (rows as f64 * scale).round() as i32;
                let bits = dib[row as usize * dib_stride..].as_ptr();
                StretchDIBits(
                    hdc, 0, 0, dest_w, dest_h, 0, 0, width as i32, rows as i32,
                    bits.cast(), &info as *const MonoBitmapInfo as *const BITMAPINFO, DIB_RGB_COLORS, SRCCOPY,
                );
                EndPage(hdc);
                row += rows;
            }
            EndDoc(hdc);
            DeleteDC(hdc);
        }
        Ok(())
    }
}

#[cfg(not(windows))]
pub mod gdi {
    pub fn print_bitmap(_printer: &str, _width: u32, _height: u32, _bitmap: &[u8], _paper_width_mm: u32) -> Result<(), String> {
        Err("Windows driver printing is only available on Windows".into())
    }
}
