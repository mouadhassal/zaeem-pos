//! Diagnostic: does a minimal PLAIN ASCII job (no codepage command, no
//! Arabic, nothing but "hello world" + a line feed + cut) succeed on this
//! printer? If this ALSO fails the same way test_print.rs does, the
//! problem is proven to be hardware/transmission, not language/encoding.
use printers::common::base::job::PrinterJobOptions;

fn main() {
    let printer_name = std::env::args().nth(1).expect("usage: test_print_ascii <system_printer_name>");

    let mut bytes: Vec<u8> = Vec::new();
    bytes.extend([0x1b, 0x40]); // ESC @ -- init only, no codepage command at all
    bytes.extend(b"HELLO WORLD\n");
    bytes.extend(b"PRINTER TEST 123\n");
    bytes.extend([0x0a, 0x0a, 0x0a]); // a few line feeds
    bytes.extend([0x1d, 0x56, 0x00]); // cut

    println!("printer: {printer_name}");
    println!("payload: {} bytes (pure ASCII, no codepage command)", bytes.len());

    let printer = printers::get_printer_by_name(&printer_name)
        .unwrap_or_else(|| panic!("no such system printer: {printer_name}"));

    match printer.print(&bytes, PrinterJobOptions::none()) {
        Ok(job_id) => println!("OK: print job submitted, job_id={job_id}"),
        Err(e) => {
            println!("FAILED: {}", e.message);
            std::process::exit(1);
        }
    }
}
