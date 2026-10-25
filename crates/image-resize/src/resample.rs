//! Separable resampling (Lanczos, Mitchell, bilinear, box) and nearest
//! neighbour, in linear light with premultiplied alpha.
//!
//! Resampling in sRGB darkens fine bright detail when downscaling (the
//! average of two gamma-encoded values is too dark), so pixels are decoded to
//! linear light first. Premultiplying alpha keeps transparent pixels from
//! bleeding their (invisible) colour into the edges of opaque ones.

use std::f32::consts::PI;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Filter {
    /// Area average when shrinking, blocky when enlarging.
    Box,
    /// Tent filter, i.e. bilinear.
    Triangle,
    /// Mitchell-Netravali cubic (B = C = 1/3): soft, no ringing to speak of.
    Mitchell,
    Lanczos2,
    Lanczos3,
}

impl Filter {
    pub fn from_name(s: &str) -> Filter {
        match s {
            "box" => Filter::Box,
            "triangle" | "bilinear" => Filter::Triangle,
            "mitchell" | "bicubic" => Filter::Mitchell,
            "lanczos2" => Filter::Lanczos2,
            _ => Filter::Lanczos3,
        }
    }

    fn support(self) -> f32 {
        match self {
            Filter::Box => 0.5,
            Filter::Triangle => 1.0,
            Filter::Mitchell | Filter::Lanczos2 => 2.0,
            Filter::Lanczos3 => 3.0,
        }
    }

    fn eval(self, x: f32) -> f32 {
        let ax = x.abs();
        match self {
            Filter::Box => {
                if x > -0.5 && x <= 0.5 {
                    1.0
                } else {
                    0.0
                }
            }
            Filter::Triangle => (1.0 - ax).max(0.0),
            Filter::Mitchell => mitchell(ax),
            Filter::Lanczos2 => lanczos(x, 2.0),
            Filter::Lanczos3 => lanczos(x, 3.0),
        }
    }
}

fn mitchell(x: f32) -> f32 {
    const B: f32 = 1.0 / 3.0;
    const C: f32 = 1.0 / 3.0;
    let (x2, x3) = (x * x, x * x * x);
    let v = if x < 1.0 {
        (12.0 - 9.0 * B - 6.0 * C) * x3 + (-18.0 + 12.0 * B + 6.0 * C) * x2 + (6.0 - 2.0 * B)
    } else if x < 2.0 {
        (-B - 6.0 * C) * x3
            + (6.0 * B + 30.0 * C) * x2
            + (-12.0 * B - 48.0 * C) * x
            + (8.0 * B + 24.0 * C)
    } else {
        0.0
    };
    v / 6.0
}

fn sinc(x: f32) -> f32 {
    if x.abs() < 1e-6 {
        1.0
    } else {
        let px = PI * x;
        px.sin() / px
    }
}

fn lanczos(x: f32, a: f32) -> f32 {
    if x.abs() >= a {
        0.0
    } else {
        sinc(x) * sinc(x / a)
    }
}

fn srgb_to_linear(c: f32) -> f32 {
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

fn linear_to_srgb(c: f32) -> f32 {
    if c <= 0.003_130_8 {
        c * 12.92
    } else {
        1.055 * c.powf(1.0 / 2.4) - 0.055
    }
}

/// For each output index: first input index and normalised weights.
struct Taps {
    start: Vec<usize>,
    weights: Vec<Vec<f32>>,
}

fn taps(src: usize, dst: usize, filter: Filter) -> Taps {
    let scale = src as f32 / dst as f32;
    // Widen the kernel when shrinking so it also acts as a low-pass filter.
    let fscale = scale.max(1.0);
    let support = filter.support() * fscale;
    let mut start = Vec::with_capacity(dst);
    let mut weights = Vec::with_capacity(dst);
    for i in 0..dst {
        let center = (i as f32 + 0.5) * scale;
        let lo = ((center - support).floor().max(0.0)) as usize;
        let hi = ((center + support).ceil() as usize).min(src);
        let mut w: Vec<f32> = (lo..hi)
            .map(|j| filter.eval((j as f32 + 0.5 - center) / fscale))
            .collect();
        let mut sum: f32 = w.iter().sum();
        if sum.abs() <= 1e-8 {
            // Box filter landing between taps: take the nearest pixel.
            w.iter_mut().for_each(|v| *v = 0.0);
            let j = (center.floor() as usize).clamp(lo, hi.saturating_sub(1));
            w[j - lo] = 1.0;
            sum = 1.0;
        }
        {
            for v in &mut w {
                *v /= sum;
            }
        }
        start.push(lo);
        weights.push(w);
    }
    Taps { start, weights }
}

/// Nearest-neighbour resize: every output pixel is a copy of one input pixel.
/// Integer factors give perfectly even blocks.
pub fn nearest(rgba: &[u8], w: usize, h: usize, nw: usize, nh: usize) -> Vec<u8> {
    if nw == 0 || nh == 0 || w == 0 || h == 0 {
        return Vec::new();
    }
    // Sample at output pixel centres; exact integer maths avoids drift.
    let xs: Vec<usize> = (0..nw)
        .map(|x| ((2 * x + 1) * w / (2 * nw)).min(w - 1))
        .collect();
    let mut out = vec![0u8; nw * nh * 4];
    for y in 0..nh {
        let sy = ((2 * y + 1) * h / (2 * nh)).min(h - 1);
        let src = &rgba[sy * w * 4..(sy + 1) * w * 4];
        let dst = &mut out[y * nw * 4..(y + 1) * nw * 4];
        for (x, &sx) in xs.iter().enumerate() {
            dst[x * 4..x * 4 + 4].copy_from_slice(&src[sx * 4..sx * 4 + 4]);
        }
    }
    out
}

/// Resize RGBA bytes from `w`×`h` to `nw`×`nh` with a separable filter.
/// `linear`: filter in linear light (correct) instead of on sRGB values.
pub fn resize(
    rgba: &[u8],
    w: usize,
    h: usize,
    nw: usize,
    nh: usize,
    filter: Filter,
    linear: bool,
) -> Vec<u8> {
    if nw == 0 || nh == 0 || w == 0 || h == 0 {
        return Vec::new();
    }
    let lut: Vec<f32> = (0..256)
        .map(|i| {
            let c = i as f32 / 255.0;
            if linear {
                srgb_to_linear(c)
            } else {
                c
            }
        })
        .collect();
    let encode = |v: f32| if linear { linear_to_srgb(v) } else { v };

    // Decode to linear, premultiplied f32.
    let mut lin = vec![0f32; w * h * 4];
    for (i, p) in rgba[..w * h * 4].chunks_exact(4).enumerate() {
        let a = p[3] as f32 / 255.0;
        lin[i * 4] = lut[p[0] as usize] * a;
        lin[i * 4 + 1] = lut[p[1] as usize] * a;
        lin[i * 4 + 2] = lut[p[2] as usize] * a;
        lin[i * 4 + 3] = a;
    }

    // Horizontal pass: w×h -> nw×h.
    let tx = taps(w, nw, filter);
    let mut mid = vec![0f32; nw * h * 4];
    for y in 0..h {
        let src = &lin[y * w * 4..(y + 1) * w * 4];
        let dst = &mut mid[y * nw * 4..(y + 1) * nw * 4];
        for x in 0..nw {
            let s = tx.start[x];
            let mut acc = [0f32; 4];
            for (k, &wt) in tx.weights[x].iter().enumerate() {
                let j = (s + k) * 4;
                acc[0] += src[j] * wt;
                acc[1] += src[j + 1] * wt;
                acc[2] += src[j + 2] * wt;
                acc[3] += src[j + 3] * wt;
            }
            dst[x * 4..x * 4 + 4].copy_from_slice(&acc);
        }
    }
    drop(lin);

    // Vertical pass: nw×h -> nw×nh, accumulating whole rows for locality.
    let ty = taps(h, nh, filter);
    let mut out = vec![0u8; nw * nh * 4];
    let mut acc = vec![0f32; nw * 4];
    for y in 0..nh {
        acc.iter_mut().for_each(|v| *v = 0.0);
        let s = ty.start[y];
        for (k, &wt) in ty.weights[y].iter().enumerate() {
            let row = &mid[(s + k) * nw * 4..(s + k + 1) * nw * 4];
            for (a, &v) in acc.iter_mut().zip(row) {
                *a += v * wt;
            }
        }
        let dst = &mut out[y * nw * 4..(y + 1) * nw * 4];
        for x in 0..nw {
            let a = acc[x * 4 + 3].clamp(0.0, 1.0);
            let o = &mut dst[x * 4..x * 4 + 4];
            if a <= 1e-6 {
                o.copy_from_slice(&[0, 0, 0, 0]);
                continue;
            }
            for c in 0..3 {
                let v = (acc[x * 4 + c] / a).clamp(0.0, 1.0);
                o[c] = (encode(v) * 255.0 + 0.5) as u8;
            }
            o[3] = (a * 255.0 + 0.5) as u8;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flat_colour_stays_flat() {
        let img: Vec<u8> = [200u8, 100, 50, 255].repeat(37 * 23);
        for f in [
            Filter::Box,
            Filter::Triangle,
            Filter::Mitchell,
            Filter::Lanczos2,
            Filter::Lanczos3,
        ] {
            let out = resize(&img, 37, 23, 11, 64, f, true);
            assert_eq!(out.len(), 11 * 64 * 4);
            for p in out.chunks(4) {
                assert!((p[0] as i32 - 200).abs() <= 1, "{p:?}");
                assert!((p[1] as i32 - 100).abs() <= 1, "{p:?}");
                assert!((p[2] as i32 - 50).abs() <= 1, "{p:?}");
                assert_eq!(p[3], 255);
            }
        }
    }

    #[test]
    fn nearest_integer_upscale_makes_blocks() {
        let img = vec![1, 2, 3, 4, 5, 6, 7, 8]; // 2×1
        let out = nearest(&img, 2, 1, 6, 2);
        assert_eq!(&out[0..12], &[1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4]);
        assert_eq!(&out[12..24], &[5, 6, 7, 8, 5, 6, 7, 8, 5, 6, 7, 8]);
        assert_eq!(&out[24..36], &out[0..12]);
    }

    #[test]
    fn transparent_pixels_do_not_bleed() {
        // Half opaque red, half fully transparent green.
        let mut img = Vec::new();
        for _y in 0..8 {
            for x in 0..16 {
                img.extend_from_slice(if x < 8 {
                    &[255, 0, 0, 255]
                } else {
                    &[0, 255, 0, 0]
                });
            }
        }
        let out = resize(&img, 16, 8, 5, 3, Filter::Lanczos3, true);
        for p in out.chunks(4) {
            if p[3] > 0 {
                assert!(p[1] < 8, "green bled in: {p:?}");
            }
        }
    }
}
