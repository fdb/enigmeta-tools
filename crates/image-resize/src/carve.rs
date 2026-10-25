//! Seam carving (Avidan & Shamir 2007) with forward energy (Rubinstein,
//! Shamir & Avidan 2008).
//!
//! The carver always works on vertical seams (one pixel per row, top to
//! bottom). Horizontal seams are handled by transposing the image first, so
//! there is only one DP routine to get right.
//!
//! Forward energy scores a seam by the new edges its removal would create,
//! instead of by the gradient of the pixels it removes. That avoids the
//! jagged artefacts backward energy leaves on straight lines.

/// Energy added per pixel under the protect brush. Large enough that a seam
/// crosses a protected area only when nothing else is left.
pub const PROTECT: f32 = 1.0e4;
/// Energy added per pixel under the remove brush (negative: seams seek it).
pub const REMOVE: f32 = -1.0e4;

#[derive(Clone, Default)]
pub struct Carver {
    w: usize,
    h: usize,
    /// RGBA, packed little-endian (r in the low byte).
    px: Vec<u32>,
    /// Luminance, 0..255.
    lum: Vec<f32>,
    /// Per-pixel energy bias from the protect/remove mask.
    bias: Vec<f32>,
    /// Index of each pixel in the image the carver started from.
    orig: Vec<u32>,
    /// 1 where the pixel was created by seam insertion.
    inserted: Vec<u8>,
    transposed: bool,
    /// Forward energy (true) or backward gradient energy (false).
    pub forward: bool,
    w0: usize,
    h0: usize,
    // Scratch for the DP.
    back: Vec<i8>,
    seam: Vec<u32>,
    // Seam insertion in progress.
    ins: Option<Box<Insertion>>,
}

#[derive(Clone)]
struct Insertion {
    /// A copy of the carver that seams are removed from, to find the k
    /// lowest-energy distinct seams.
    work: Carver,
    /// Column (in the image being enlarged) of each pixel in `work`.
    col: Vec<u32>,
    /// Columns picked per row.
    picked: Vec<Vec<u32>>,
    target: usize,
}

#[inline]
fn luma(p: u32) -> f32 {
    let r = (p & 0xff) as f32;
    let g = ((p >> 8) & 0xff) as f32;
    let b = ((p >> 16) & 0xff) as f32;
    0.299 * r + 0.587 * g + 0.114 * b
}

#[inline]
fn avg(a: u32, b: u32) -> u32 {
    let mut out = 0u32;
    for s in [0, 8, 16, 24] {
        let x = (a >> s) & 0xff;
        let y = (b >> s) & 0xff;
        out |= ((x + y + 1) / 2) << s;
    }
    out
}

fn transpose<T: Copy + Default>(v: &mut Vec<T>, w: usize, h: usize) {
    let mut out = vec![T::default(); v.len()];
    for y in 0..h {
        let row = &v[y * w..y * w + w];
        for (x, &p) in row.iter().enumerate() {
            out[x * h + y] = p;
        }
    }
    *v = out;
}

/// Drop one element per row (at `seam[y]`), compacting in place.
fn remove_cols<T: Copy>(v: &mut Vec<T>, w: usize, h: usize, seam: &[u32]) {
    // Row y moves left by y elements before its seam and y + 1 after it, so
    // each row is two block moves.
    for y in 0..h {
        let s = seam[y] as usize;
        let row = y * w;
        if y > 0 {
            v.copy_within(row..row + s, row - y);
        }
        v.copy_within(row + s + 1..row + w, row + s - y);
    }
    v.truncate(h * (w - 1));
}

/// One row of the forward-energy DP. The cost of removing (x, y) is the
/// difference between the neighbours that become adjacent: left and right
/// always, plus up and left (or up and right) if the seam steps diagonally.
#[inline]
fn pick(prev: &[f32], x: usize, w: usize, cl: f32, cu: f32, cr: f32) -> (f32, i8) {
    let mut best = prev[x] + cu;
    let mut b = 0i8;
    if x > 0 {
        let c = prev[x - 1] + cl;
        if c < best {
            best = c;
            b = -1;
        }
    }
    if x + 1 < w {
        let c = prev[x + 1] + cr;
        if c < best {
            best = c;
            b = 1;
        }
    }
    (best, b)
}

fn dp_row_forward(
    l: &[f32],
    up: &[f32],
    bias: &[f32],
    prev: &[f32],
    cur: &mut [f32],
    back: &mut [i8],
    first: bool,
) {
    let w = l.len();
    let edge = |x: usize| -> (f32, f32, f32) {
        let left = if x > 0 { l[x - 1] } else { l[x] };
        let right = if x + 1 < w { l[x + 1] } else { l[x] };
        // At the border there is no pixel to join, so removing it would be
        // free and seams would eat the image from the sides. Charge the
        // one-sided gradient instead, doubled to match the two-pixel span
        // used inside.
        let cu = if x > 0 && x + 1 < w {
            (right - left).abs()
        } else {
            2.0 * (right - left).abs()
        };
        (cu + (up[x] - left).abs(), cu, cu + (up[x] - right).abs())
    };
    if first {
        for x in 0..w {
            cur[x] = bias[x] + edge(x).1;
            back[x] = 0;
        }
        return;
    }
    let mut ends = vec![0];
    if w > 1 {
        ends.push(w - 1);
    }
    for x in ends {
        let (cl, cu, cr) = edge(x);
        let (best, b) = pick(prev, x, w, cl, cu, cr);
        cur[x] = bias[x] + best;
        back[x] = b;
    }
    if w < 3 {
        return;
    }
    // Interior: zipped windows, so there are no bounds checks in the loop.
    let it = l
        .windows(3)
        .zip(prev.windows(3))
        .zip(&up[1..w - 1])
        .zip(&bias[1..w - 1])
        .zip(cur[1..w - 1].iter_mut().zip(back[1..w - 1].iter_mut()));
    for ((((lw, pw), &u), &e), (c, bk)) in it {
        let (left, right) = (lw[0], lw[2]);
        let cu = (right - left).abs();
        let a = pw[0] + cu + (u - left).abs();
        let m = pw[1] + cu;
        let r = pw[2] + cu + (u - right).abs();
        // Branch-free so the loop can vectorise.
        let am = a < m;
        let best_l = if am { a } else { m };
        let b_l: i8 = if am { -1 } else { 0 };
        let rb = r < best_l;
        *c = e + if rb { r } else { best_l };
        *bk = if rb { 1 } else { b_l };
    }
}

/// One row of the classic DP: energy is the gradient magnitude of the pixel.
#[allow(clippy::too_many_arguments)]
fn dp_row_backward(
    l: &[f32],
    up: &[f32],
    down: &[f32],
    bias: &[f32],
    prev: &[f32],
    cur: &mut [f32],
    back: &mut [i8],
    first: bool,
) {
    let w = l.len();
    for x in 0..w {
        let left = if x > 0 { l[x - 1] } else { l[x] };
        let right = if x + 1 < w { l[x + 1] } else { l[x] };
        // One-sided differences at the borders span one pixel, not two.
        let dx = (right - left).abs() * if x == 0 || x + 1 == w { 2.0 } else { 1.0 };
        let e = bias[x] + dx + (down[x] - up[x]).abs();
        if first {
            cur[x] = e;
            back[x] = 0;
            continue;
        }
        let (best, b) = pick(prev, x, w, 0.0, 0.0, 0.0);
        cur[x] = e + best;
        back[x] = b;
    }
}

impl Carver {
    pub fn new(rgba: &[u8], w: usize, h: usize) -> Carver {
        let n = w * h;
        let mut px = Vec::with_capacity(n);
        for c in rgba[..n * 4].chunks_exact(4) {
            px.push(u32::from_le_bytes([c[0], c[1], c[2], c[3]]));
        }
        let lum = px.iter().map(|&p| luma(p)).collect();
        Carver {
            w,
            h,
            px,
            lum,
            bias: vec![0.0; n],
            orig: (0..n as u32).collect(),
            inserted: vec![0; n],
            transposed: false,
            forward: true,
            w0: w,
            h0: h,
            ..Default::default()
        }
    }

    /// Apply a protect/remove mask (1 = protect, 2 = remove, else neutral) of
    /// any size; it is sampled nearest-neighbour onto the image. Call before
    /// carving.
    pub fn set_mask(&mut self, mask: &[u8], mw: usize, mh: usize) {
        if mw == 0 || mh == 0 || mask.len() < mw * mh {
            return;
        }
        let (w, h) = (self.w0, self.h0);
        for (i, &o) in self.orig.iter().enumerate() {
            let o = o as usize;
            let (x, y) = (o % w, o / w);
            let mx = (x * mw / w).min(mw - 1);
            let my = (y * mh / h).min(mh - 1);
            self.bias[i] = match mask[my * mw + mx] {
                1 => PROTECT,
                2 => REMOVE,
                _ => 0.0,
            };
        }
    }

    /// Width and height in the image's own orientation.
    pub fn width(&self) -> usize {
        if self.transposed {
            self.h
        } else {
            self.w
        }
    }
    pub fn height(&self) -> usize {
        if self.transposed {
            self.w
        } else {
            self.h
        }
    }

    /// Switch between carving columns (false) and rows (true).
    pub fn set_transposed(&mut self, t: bool) {
        if t == self.transposed {
            return;
        }
        let (w, h) = (self.w, self.h);
        transpose(&mut self.px, w, h);
        transpose(&mut self.lum, w, h);
        transpose(&mut self.bias, w, h);
        transpose(&mut self.orig, w, h);
        transpose(&mut self.inserted, w, h);
        self.w = h;
        self.h = w;
        self.transposed = t;
    }

    /// Current width in carving orientation (the dimension seams shrink).
    pub fn carve_width(&self) -> usize {
        self.w
    }

    /// Find the minimum-energy vertical seam into `self.seam`.
    fn find_seam(&mut self) {
        let (w, h) = (self.w, self.h);
        self.back.resize(w * h, 0);
        let mut prev = vec![0f32; w];
        let mut cur = vec![0f32; w];
        for y in 0..h {
            let row = y * w;
            let l = &self.lum[row..row + w];
            let up = if y > 0 { &self.lum[row - w..row] } else { l };
            let down = if y + 1 < h {
                &self.lum[row + w..row + 2 * w]
            } else {
                l
            };
            let bias = &self.bias[row..row + w];
            let back = &mut self.back[row..row + w];
            if self.forward {
                dp_row_forward(l, up, bias, &prev, &mut cur, back, y == 0);
            } else {
                dp_row_backward(l, up, down, bias, &prev, &mut cur, back, y == 0);
            }
            std::mem::swap(&mut prev, &mut cur);
        }

        let mut x = 0;
        let mut best = f32::INFINITY;
        for (i, &c) in prev.iter().enumerate() {
            if c < best {
                best = c;
                x = i;
            }
        }
        self.seam.resize(h, 0);
        for y in (0..h).rev() {
            self.seam[y] = x as u32;
            let b = self.back[y * w + x];
            x = (x as isize + b as isize) as usize;
        }
    }

    fn remove_found_seam(&mut self) {
        let (w, h) = (self.w, self.h);
        let seam = std::mem::take(&mut self.seam);
        remove_cols(&mut self.px, w, h, &seam);
        remove_cols(&mut self.lum, w, h, &seam);
        remove_cols(&mut self.bias, w, h, &seam);
        remove_cols(&mut self.orig, w, h, &seam);
        remove_cols(&mut self.inserted, w, h, &seam);
        self.seam = seam;
        self.w -= 1;
    }

    /// Remove up to `n` seams. Returns how many were removed.
    pub fn remove_seams(&mut self, n: usize) -> usize {
        let mut done = 0;
        while done < n && self.w > 1 {
            self.find_seam();
            self.remove_found_seam();
            done += 1;
        }
        done
    }

    /// Start inserting `k` seams. At most `w - 1` seams can be found in one
    /// pass; larger enlargements need several passes.
    pub fn begin_insert(&mut self, k: usize) -> usize {
        let k = k.min(self.w.saturating_sub(1));
        let mut work = self.clone();
        work.ins = None;
        work.px = Vec::new(); // colours are not needed to find seams
        let col = (0..self.w * self.h).map(|i| (i % self.w) as u32).collect();
        self.ins = Some(Box::new(Insertion {
            work,
            col,
            picked: vec![Vec::with_capacity(k); self.h],
            target: k,
        }));
        k
    }

    /// Find up to `n` more seams for the pending insertion. Returns how many
    /// remain.
    pub fn insert_step(&mut self, n: usize) -> usize {
        let Some(ins) = self.ins.as_mut() else {
            return 0;
        };
        let mut i = 0;
        while i < n && ins.picked[0].len() < ins.target {
            let wk = &mut ins.work;
            wk.find_seam();
            let (w, h) = (wk.w, wk.h);
            for y in 0..h {
                ins.picked[y].push(ins.col[y * w + wk.seam[y] as usize]);
            }
            remove_cols(&mut ins.col, w, h, &wk.seam);
            // Only lum and bias drive the DP; px/orig/inserted are not kept.
            let seam = std::mem::take(&mut wk.seam);
            remove_cols(&mut wk.lum, w, h, &seam);
            remove_cols(&mut wk.bias, w, h, &seam);
            wk.seam = seam;
            wk.w -= 1;
            i += 1;
        }
        ins.target - ins.picked[0].len()
    }

    /// Duplicate the seams found by `insert_step`. Each inserted pixel is the
    /// average of the seam pixel and its right neighbour.
    pub fn finish_insert(&mut self) {
        let Some(mut ins) = self.ins.take() else {
            return;
        };
        let k = ins.picked[0].len();
        if k == 0 {
            return;
        }
        let (w, h) = (self.w, self.h);
        let nw = w + k;
        let mut px = Vec::with_capacity(nw * h);
        let mut lum = Vec::with_capacity(nw * h);
        let mut bias = Vec::with_capacity(nw * h);
        let mut orig = Vec::with_capacity(nw * h);
        let mut inserted = Vec::with_capacity(nw * h);
        for y in 0..h {
            let picks = &mut ins.picked[y];
            picks.sort_unstable();
            let row = y * w;
            let mut p = 0;
            for x in 0..w {
                let i = row + x;
                px.push(self.px[i]);
                lum.push(self.lum[i]);
                bias.push(self.bias[i]);
                orig.push(self.orig[i]);
                inserted.push(self.inserted[i]);
                while p < picks.len() && picks[p] as usize == x {
                    let j = if x + 1 < w { i + 1 } else { i };
                    let c = avg(self.px[i], self.px[j]);
                    px.push(c);
                    lum.push(luma(c));
                    // Nudge inserted pixels up so a later pass does not pick
                    // the same seams again and stretch them further.
                    bias.push(self.bias[i].max(0.0) + 32.0);
                    orig.push(self.orig[i]);
                    inserted.push(1);
                    p += 1;
                }
            }
        }
        self.px = px;
        self.lum = lum;
        self.bias = bias;
        self.orig = orig;
        self.inserted = inserted;
        self.w = nw;
    }

    /// The image in its own orientation, as RGBA bytes.
    pub fn rgba(&self) -> Vec<u8> {
        let mut c = self.clone_maps();
        c.set_transposed(false);
        let mut out = Vec::with_capacity(c.px.len() * 4);
        for p in &c.px {
            out.extend_from_slice(&p.to_le_bytes());
        }
        out
    }

    /// 1 for each pixel of the starting image that was carved away.
    pub fn removed_map(&self) -> Vec<u8> {
        let mut out = vec![1u8; self.w0 * self.h0];
        for &o in &self.orig {
            out[o as usize] = 0;
        }
        out
    }

    /// 1 for each pixel of the output that was created by seam insertion.
    pub fn inserted_map(&self) -> Vec<u8> {
        let mut c = self.clone_maps();
        c.set_transposed(false);
        c.inserted
    }

    fn clone_maps(&self) -> Carver {
        Carver {
            w: self.w,
            h: self.h,
            px: self.px.clone(),
            inserted: self.inserted.clone(),
            transposed: self.transposed,
            forward: self.forward,
            ..Default::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image(w: usize, h: usize, f: impl Fn(usize, usize) -> [u8; 4]) -> Vec<u8> {
        let mut v = Vec::new();
        for y in 0..h {
            for x in 0..w {
                v.extend_from_slice(&f(x, y));
            }
        }
        v
    }

    #[test]
    fn removes_flat_area_before_an_edge() {
        // Black left half, a white stripe at x = 15..17, black right half.
        let (w, h) = (32, 16);
        let img = image(w, h, |x, _| {
            if (15..17).contains(&x) {
                [255; 4]
            } else {
                [0, 0, 0, 255]
            }
        });
        let mut c = Carver::new(&img, w, h);
        assert_eq!(c.remove_seams(10), 10);
        assert_eq!(c.width(), 22);
        let out = c.rgba();
        let white: usize = out.chunks(4).filter(|p| p[0] == 255).count();
        assert_eq!(white, 2 * h, "the stripe survives intact");
    }

    #[test]
    fn backward_energy_also_spares_the_edge() {
        let (w, h) = (32, 16);
        let img = image(w, h, |x, _| {
            if (15..17).contains(&x) {
                [255; 4]
            } else {
                [0, 0, 0, 255]
            }
        });
        let mut c = Carver::new(&img, w, h);
        c.forward = false;
        c.remove_seams(10);
        let white = c.rgba().chunks(4).filter(|p| p[0] == 255).count();
        assert_eq!(white, 2 * h);
    }

    #[test]
    fn seams_do_not_hug_the_border() {
        // Busy noise everywhere except a flat band in the middle: the band
        // must go first, not the image edges.
        let (w, h) = (40, 20);
        let img = image(w, h, |x, y| {
            if (15..25).contains(&x) {
                [90, 90, 90, 255]
            } else {
                let v = ((x * 73 + y * 151) % 7 * 36) as u8;
                [v, v, v, 255]
            }
        });
        for forward in [true, false] {
            let mut c = Carver::new(&img, w, h);
            c.forward = forward;
            c.remove_seams(6);
            for (i, &r) in c.removed_map().iter().enumerate() {
                if r == 1 {
                    assert!(
                        (14..26).contains(&(i % w)),
                        "forward={forward}: removed x={}",
                        i % w
                    );
                }
            }
        }
    }

    #[test]
    fn horizontal_seams_via_transpose() {
        let (w, h) = (20, 30);
        let img = image(w, h, |x, y| [(x * 10) as u8, (y * 8) as u8, 0, 255]);
        let mut c = Carver::new(&img, w, h);
        c.set_transposed(true);
        c.remove_seams(5);
        c.set_transposed(false);
        assert_eq!((c.width(), c.height()), (20, 25));
        assert_eq!(c.rgba().len(), 20 * 25 * 4);
        assert_eq!(c.removed_map().iter().filter(|&&r| r == 1).count(), 5 * 20);
    }

    #[test]
    fn insertion_grows_and_marks() {
        let (w, h) = (16, 8);
        let img = image(w, h, |x, y| [(x * 16) as u8, (y * 30) as u8, 7, 255]);
        let mut c = Carver::new(&img, w, h);
        let k = c.begin_insert(6);
        assert_eq!(k, 6);
        while c.insert_step(2) > 0 {}
        c.finish_insert();
        assert_eq!(c.width(), 22);
        assert_eq!(c.inserted_map().iter().filter(|&&m| m == 1).count(), 6 * h);
    }

    #[test]
    fn protect_mask_steers_seams() {
        // Uniform image: without a mask any column could go; protect the
        // left half and every removed pixel must come from the right half.
        let (w, h) = (20, 10);
        let img = image(w, h, |_, _| [128, 128, 128, 255]);
        let mut c = Carver::new(&img, w, h);
        let mask: Vec<u8> = (0..w * h).map(|i| if i % w < 10 { 1 } else { 0 }).collect();
        c.set_mask(&mask, w, h);
        c.remove_seams(5);
        for (i, &r) in c.removed_map().iter().enumerate() {
            if r == 1 {
                assert!(i % w >= 10);
            }
        }
    }
}
