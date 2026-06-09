// Local verification helper: wrap a raw CFF table into an OTF.
//   cargo run --example wrap -- input.cff output.otf
use std::io::Write;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let cff = std::fs::read(&args[1]).expect("read cff");
    match pdf_extract::cff::cff_to_otf(&cff) {
        Some(otf) => {
            std::fs::File::create(&args[2])
                .unwrap()
                .write_all(&otf)
                .unwrap();
            eprintln!("wrote {} bytes", otf.len());
        }
        None => {
            eprintln!("cff_to_otf returned None");
            std::process::exit(1);
        }
    }
}
