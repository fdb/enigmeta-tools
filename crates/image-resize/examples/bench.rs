//! cargo run --release --example bench
use image_resize::carve::Carver;
use std::time::Instant;
fn main() {
    let (w, h) = (1200, 800);
    let img: Vec<u8> = (0..w * h * 4).map(|i| ((i * 7919) % 251) as u8).collect();
    let mut c = Carver::new(&img, w, h);
    let t = Instant::now();
    c.remove_seams(300);
    println!("300 seams on {w}x{h}: {:?}", t.elapsed());
}
