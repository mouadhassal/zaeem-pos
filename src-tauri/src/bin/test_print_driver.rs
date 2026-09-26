//! Manual check for the "Windows driver" print mode: draws a test pattern
//! (border, diagonal, stripes) through a printer's own Windows driver.
//! `test_print_driver "<printer>" [output-file] [paper-mm]` -- with
//! "Microsoft Print to PDF" and an output path it writes a PDF to inspect.
//! Never shipped, never invoked by the app.
fn main() {
    let mut args = std::env::args().skip(1);
    let printer = args.next().expect("usage: test_print_driver <printer> [output] [paper-mm]");
    let output = args.next();
    let paper: u32 = args.next().and_then(|v| v.parse().ok()).unwrap_or(80);
    let (w, h) = (576u32, 900u32);
    let stride = w.div_ceil(8) as usize;
    let mut bmp = vec![0u8; stride * h as usize];
    let mut set = |x: u32, y: u32| bmp[y as usize * stride + (x >> 3) as usize] |= 0x80 >> (x & 7);
    for y in 0..h {
        for x in 0..w {
            let border = x < 6 || x >= w - 6 || y < 6 || y >= h - 6;
            let diag = (x as i32 - (y as i32 * w as i32 / h as i32)).abs() < 3;
            let stripe = y > 700 && (x / 24) % 2 == 0;
            if border || diag || stripe {
                set(x, y);
            }
        }
    }
    match app_lib::print::gdi::print_bitmap_to(&printer, w, h, &bmp, paper, output.as_deref()) {
        Ok(()) => println!("ok"),
        Err(e) => println!("ERR {e}"),
    }
}
