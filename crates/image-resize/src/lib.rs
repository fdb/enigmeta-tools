//! Image resizing for the browser: filtered and pixelated scaling, and content-aware
//! scaling by seam carving. The worker drives the carver in small steps so it
//! can report progress and be cancelled between steps.

use wasm_bindgen::prelude::*;

pub mod carve;
pub mod resample;

/// Filtered resize of RGBA bytes. `filter`: box, triangle, mitchell,
/// lanczos2 or lanczos3.
#[wasm_bindgen]
pub fn resize(
    rgba: &[u8],
    w: u32,
    h: u32,
    nw: u32,
    nh: u32,
    filter: &str,
    linear: bool,
) -> Vec<u8> {
    let f = resample::Filter::from_name(filter);
    resample::resize(
        rgba,
        w as usize,
        h as usize,
        nw as usize,
        nh as usize,
        f,
        linear,
    )
}

/// Nearest-neighbour (pixelated) resize of RGBA bytes.
#[wasm_bindgen]
pub fn nearest(rgba: &[u8], w: u32, h: u32, nw: u32, nh: u32) -> Vec<u8> {
    resample::nearest(rgba, w as usize, h as usize, nw as usize, nh as usize)
}

#[wasm_bindgen]
pub struct Carver(carve::Carver);

#[wasm_bindgen]
impl Carver {
    #[wasm_bindgen(constructor)]
    pub fn new(rgba: &[u8], w: u32, h: u32) -> Carver {
        Carver(carve::Carver::new(rgba, w as usize, h as usize))
    }

    /// 1 = protect, 2 = remove, anything else neutral. Any size; sampled
    /// nearest-neighbour onto the image.
    pub fn set_mask(&mut self, mask: &[u8], mw: u32, mh: u32) {
        self.0.set_mask(mask, mw as usize, mh as usize);
    }

    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.0.width() as u32
    }

    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.0.height() as u32
    }

    /// true: forward energy (default); false: classic gradient energy.
    pub fn set_forward(&mut self, forward: bool) {
        self.0.forward = forward;
    }

    /// false: seams change the width; true: seams change the height.
    pub fn set_rows(&mut self, rows: bool) {
        self.0.set_transposed(rows);
    }

    pub fn remove_seams(&mut self, n: u32) -> u32 {
        self.0.remove_seams(n as usize) as u32
    }

    /// Returns how many seams this pass will insert (at most width - 1).
    pub fn begin_insert(&mut self, k: u32) -> u32 {
        self.0.begin_insert(k as usize) as u32
    }

    /// Returns how many seams remain to be found.
    pub fn insert_step(&mut self, n: u32) -> u32 {
        self.0.insert_step(n as usize) as u32
    }

    pub fn finish_insert(&mut self) {
        self.0.finish_insert();
    }

    pub fn rgba(&self) -> Vec<u8> {
        self.0.rgba()
    }

    pub fn removed_map(&self) -> Vec<u8> {
        self.0.removed_map()
    }

    pub fn inserted_map(&self) -> Vec<u8> {
        self.0.inserted_map()
    }

    /// Current size of the carved dimension.
    #[wasm_bindgen(getter)]
    pub fn carve_width(&self) -> u32 {
        self.0.carve_width() as u32
    }
}
