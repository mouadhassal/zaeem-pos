//! One-off manual verification tool: sends a real RAW ESC/POS test job to
//! a named OS printer, using the exact CP1256 encoding table the app
//! itself uses (apps/zaeem-pos/src/lib/printer.ts) -- generated the same
//! way, from iconv-lite's verified windows1256 table, not hand-typed.
//! Never shipped, never invoked by the app.
use printers::common::base::job::PrinterJobOptions;
use std::collections::HashMap;

const CP1256_CHARS: &str = "€پ‚ƒ„…†‡ˆ‰ٹ‹Œچژڈگ‘’“”•–—ک™ڑ›œ‌‍ں ،¢£¤¥¦§¨©ھ«¬­®¯°±²³´µ¶·¸¹؛»¼½¾؟ہءآأؤإئابةتثجحخدذرزسشصض×طظعغـفقكàلâمنهوçèéêëىيîïًٌٍَôُِ÷ّùْûü‎‏ے";

fn build_map() -> HashMap<char, u8> {
    let mut map = HashMap::new();
    for (i, ch) in CP1256_CHARS.chars().enumerate() {
        if ch == '\u{FFFD}' { continue; }
        map.entry(ch).or_insert((0x80 + i) as u8);
    }
    map
}

fn encode_cp1256(text: &str, map: &HashMap<char, u8>) -> Vec<u8> {
    let mut out = Vec::new();
    for ch in text.chars() {
        let code = ch as u32;
        if code < 0x80 {
            out.push(code as u8);
        } else {
            out.push(*map.get(&ch).unwrap_or(&0x3f));
        }
    }
    out
}

fn main() {
    let printer_name = std::env::args().nth(1).expect("usage: test_print <system_printer_name>");
    let map = build_map();

    let mut bytes: Vec<u8> = Vec::new();
    bytes.extend([0x1b, 0x40]); // ESC @ -- init
    bytes.extend([0x1b, 0x74, 19]); // ESC t 19 -- CP1256
    bytes.extend([0x1b, 0x61, 1]); // center align
    bytes.extend([0x1d, 0x21, 0x11]); // double width+height
    bytes.extend(encode_cp1256("اختبار طباعة\n", &map));
    bytes.extend([0x1d, 0x21, 0x00]); // normal size
    bytes.extend(encode_cp1256("WENZDES POS\n", &map));
    bytes.extend(encode_cp1256("================================\n", &map));
    bytes.extend([0x1b, 0x61, 0]); // left align
    bytes.extend(encode_cp1256("اسم الصنف: برجر دجاج\n", &map));
    bytes.extend(encode_cp1256("السعر: 15.00 ر.س\n", &map));
    bytes.extend(encode_cp1256("================================\n", &map));
    bytes.extend([0x1b, 0x61, 1]);
    bytes.extend(encode_cp1256("شكراً لزيارتكم\n\n", &map));
    bytes.extend([0x1d, 0x56, 0x00]); // cut

    println!("printer: {printer_name}");
    println!("payload: {} bytes", bytes.len());

    let printer = printers::get_printer_by_name(&printer_name)
        .unwrap_or_else(|| panic!("no such system printer: {printer_name}"));
    println!("found printer: {} (system_name={})", printer.name, printer.system_name);

    match printer.print(&bytes, PrinterJobOptions::none()) {
        Ok(job_id) => println!("OK: print job submitted, job_id={job_id}"),
        Err(e) => {
            println!("FAILED: {}", e.message);
            std::process::exit(1);
        }
    }
}
