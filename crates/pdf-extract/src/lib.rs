//! Extract embedded images and fonts from a PDF.
//!
//! Runs as WebAssembly in the browser. `extract` takes the raw PDF bytes and
//! returns a flat list of assets (each with bytes, a suggested filename, mime
//! type, and a human note). Parsing is done with `lopdf`; image samples are
//! re-encoded to PNG with the `png` crate, while already-compressed image
//! formats (JPEG/JPEG2000) are passed through untouched.

use std::collections::BTreeSet;
use std::io::Read;

use lopdf::{Dictionary, Document, Object, ObjectId, Stream};
use wasm_bindgen::prelude::*;

pub mod cff;

#[wasm_bindgen]
#[derive(Clone)]
pub struct Asset {
    kind: String,
    name: String,
    mime: String,
    width: u32,
    height: u32,
    note: String,
    bytes: Vec<u8>,
}

#[wasm_bindgen]
impl Asset {
    #[wasm_bindgen(getter)]
    pub fn kind(&self) -> String {
        self.kind.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn name(&self) -> String {
        self.name.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn mime(&self) -> String {
        self.mime.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.width
    }
    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.height
    }
    #[wasm_bindgen(getter)]
    pub fn note(&self) -> String {
        self.note.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn bytes(&self) -> Vec<u8> {
        self.bytes.clone()
    }
}

/// Returned to JS. `count` + `get(i)` avoids relying on Vec<struct> codegen.
#[wasm_bindgen]
pub struct ExtractResult {
    assets: Vec<Asset>,
}

#[wasm_bindgen]
impl ExtractResult {
    #[wasm_bindgen(getter)]
    pub fn count(&self) -> usize {
        self.assets.len()
    }
    pub fn get(&self, i: usize) -> Option<Asset> {
        self.assets.get(i).cloned()
    }
}

/// Extract assets from `data`. `on_progress`, if given, is called with
/// `(done, total)` object counts as extraction proceeds, so a worker can drive
/// a progress bar without blocking on the synchronous parse.
#[wasm_bindgen]
pub fn extract(
    data: &[u8],
    on_progress: Option<js_sys::Function>,
) -> Result<ExtractResult, JsValue> {
    let doc = Document::load_mem(data)
        .map_err(|e| JsValue::from_str(&format!("Could not parse PDF: {e}")))?;

    if doc.trailer.get(b"Encrypt").is_ok() {
        return Err(JsValue::from_str(
            "This PDF is encrypted; its assets cannot be extracted.",
        ));
    }

    let report = |done: usize, total: usize| {
        if let Some(cb) = &on_progress {
            let _ = cb.call2(&JsValue::NULL, &(done as f64).into(), &(total as f64).into());
        }
    };

    let total = doc.objects.len().max(1);
    let step = (total / 100).max(1); // throttle callbacks to ~100 updates

    let mut assets: Vec<Asset> = Vec::new();

    // Images: every stream object whose subtype is /Image.
    let mut img_n = 0usize;
    for (idx, obj) in doc.objects.values().enumerate() {
        if let Object::Stream(stream) = obj {
            if is_image(&stream.dict) {
                img_n += 1;
                if let Some(a) = extract_image(&doc, stream, img_n) {
                    assets.push(a);
                }
            }
        }
        if idx % step == 0 {
            report(idx, total);
        }
    }

    // Fonts: embedded font programs referenced from font descriptors.
    for (i, fr) in collect_font_files(&doc).into_iter().enumerate() {
        if let Some(a) = extract_font(&doc, &fr, i + 1) {
            assets.push(a);
        }
    }

    report(total, total);
    Ok(ExtractResult { assets })
}

// --- helpers ---------------------------------------------------------------

fn name_str(n: &[u8]) -> String {
    String::from_utf8_lossy(n).into_owned()
}

/// Follow indirect references to the concrete object (bounded depth).
fn resolve<'a>(doc: &'a Document, mut obj: &'a Object) -> &'a Object {
    let mut guard = 0;
    while let Object::Reference(id) = obj {
        match doc.get_object(*id) {
            Ok(o) => obj = o,
            Err(_) => break,
        }
        guard += 1;
        if guard > 8 {
            break;
        }
    }
    obj
}

fn as_int(o: &Object) -> Option<i64> {
    match o {
        Object::Integer(i) => Some(*i),
        Object::Real(r) => Some(*r as i64),
        _ => None,
    }
}

fn dict_int(doc: &Document, dict: &Dictionary, key: &[u8]) -> Option<i64> {
    dict.get(key).ok().map(|o| resolve(doc, o)).and_then(as_int)
}

fn is_image(dict: &Dictionary) -> bool {
    matches!(dict.get(b"Subtype"), Ok(Object::Name(n)) if n.as_slice() == b"Image")
}

fn filters(doc: &Document, dict: &Dictionary) -> Vec<String> {
    match dict.get(b"Filter").map(|o| resolve(doc, o)) {
        Ok(Object::Name(n)) => vec![name_str(n)],
        Ok(Object::Array(a)) => a
            .iter()
            .map(|o| resolve(doc, o))
            .filter_map(|o| match o {
                Object::Name(n) => Some(name_str(n)),
                _ => None,
            })
            .collect(),
        _ => vec![],
    }
}

fn inflate(data: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    if flate2::read::ZlibDecoder::new(data)
        .read_to_end(&mut out)
        .is_ok()
        && !out.is_empty()
    {
        return Some(out);
    }
    out.clear();
    if flate2::read::DeflateDecoder::new(data)
        .read_to_end(&mut out)
        .is_ok()
        && !out.is_empty()
    {
        return Some(out);
    }
    None
}

// --- images ----------------------------------------------------------------

fn extract_image(doc: &Document, stream: &Stream, n: usize) -> Option<Asset> {
    let dict = &stream.dict;
    let w = dict_int(doc, dict, b"Width").unwrap_or(0) as u32;
    let h = dict_int(doc, dict, b"Height").unwrap_or(0) as u32;
    let bpc = dict_int(doc, dict, b"BitsPerComponent").unwrap_or(8) as u32;
    let fs = filters(doc, dict);

    // If an image-codec filter is present, peel off the transport filters
    // (ASCII85/Hex/Flate/RunLength) that precede it and keep the codec payload.
    if let Some(codec) = image_codec(&fs) {
        let payload = predecode(stream, &fs);
        let (ext, mime, raw) = match codec {
            "DCTDecode" => ("jpg", "image/jpeg", false),
            "JPXDecode" => ("jp2", "image/jp2", false),
            "JBIG2Decode" => ("jbig2.bin", "application/octet-stream", true),
            _ => ("fax.bin", "application/octet-stream", true), // CCITTFaxDecode
        };
        return Some(Asset {
            kind: "image".into(),
            name: format!("image-{n}.{ext}"),
            mime: mime.into(),
            width: w,
            height: h,
            note: if raw {
                format!("{codec} — raw, not decoded")
            } else {
                cs_note(doc, dict)
            },
            bytes: payload,
        });
    }

    // Lossless/raw samples: decode transport filters ourselves (NOT lopdf's
    // decompressed_content, whose predictor handling corrupts some rows), then
    // reverse the PNG/TIFF predictor with correct math, and rebuild a PNG.
    let filtered = predecode(stream, &fs);
    let samples = unpredict(doc, dict, filtered, w, bpc);
    if let Some((png, note)) = build_png(doc, dict, &samples, w, h, bpc) {
        return Some(Asset {
            kind: "image".into(),
            name: format!("image-{n}.png"),
            mime: "image/png".into(),
            width: w,
            height: h,
            note,
            bytes: png,
        });
    }
    // Unsupported colorspace/bit-depth: hand back the raw samples honestly.
    Some(Asset {
        kind: "image".into(),
        name: format!("image-{n}.bin"),
        mime: "application/octet-stream".into(),
        width: w,
        height: h,
        note: format!("{} {bpc}-bit — raw samples, unsupported", cs_note(doc, dict)),
        bytes: samples,
    })
}

/// The image-codec filter in the chain, if any (vs. transport filters).
fn image_codec(fs: &[String]) -> Option<&'static str> {
    for f in fs {
        match f.as_str() {
            "DCTDecode" | "DCT" => return Some("DCTDecode"),
            "JPXDecode" => return Some("JPXDecode"),
            "JBIG2Decode" => return Some("JBIG2Decode"),
            "CCITTFaxDecode" | "CCF" => return Some("CCITTFaxDecode"),
            _ => {}
        }
    }
    None
}

/// Apply transport filters (ASCII85/Hex/Flate/RunLength) in order, stopping at
/// the first image-codec filter. The returned bytes are the codec payload.
fn predecode(stream: &Stream, fs: &[String]) -> Vec<u8> {
    let mut data = stream.content.clone();
    for f in fs {
        match f.as_str() {
            "ASCII85Decode" | "A85" => {
                if let Some(d) = ascii85_decode(&data) {
                    data = d;
                }
            }
            "ASCIIHexDecode" | "AHx" => data = asciihex_decode(&data),
            "FlateDecode" | "Fl" => {
                if let Some(d) = inflate(&data) {
                    data = d;
                }
            }
            "RunLengthDecode" | "RL" => data = rle_decode(&data),
            // Reached the image codec (or an unknown filter): stop.
            _ => break,
        }
    }
    data
}

fn ascii85_decode(data: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut tuple: u32 = 0;
    let mut count = 0u32;
    let mut i = 0;
    if data.starts_with(b"<~") {
        i = 2;
    }
    while i < data.len() {
        let c = data[i];
        i += 1;
        match c {
            b'~' => break,
            b'z' if count == 0 => out.extend_from_slice(&[0, 0, 0, 0]),
            b'!'..=b'u' => {
                tuple = tuple.wrapping_mul(85).wrapping_add((c - b'!') as u32);
                count += 1;
                if count == 5 {
                    out.extend_from_slice(&tuple.to_be_bytes());
                    tuple = 0;
                    count = 0;
                }
            }
            _ => {} // whitespace and other bytes are ignored
        }
    }
    if count > 0 {
        for _ in count..5 {
            tuple = tuple.wrapping_mul(85).wrapping_add(84); // pad with 'u'
        }
        out.extend_from_slice(&tuple.to_be_bytes()[..(count - 1) as usize]);
    }
    Some(out)
}

fn asciihex_decode(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut hi: Option<u8> = None;
    for &c in data {
        if c == b'>' {
            break;
        }
        let v = match c {
            b'0'..=b'9' => c - b'0',
            b'a'..=b'f' => c - b'a' + 10,
            b'A'..=b'F' => c - b'A' + 10,
            _ => continue,
        };
        match hi {
            None => hi = Some(v),
            Some(h) => {
                out.push((h << 4) | v);
                hi = None;
            }
        }
    }
    if let Some(h) = hi {
        out.push(h << 4);
    }
    out
}

fn rle_decode(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < data.len() {
        let len = data[i];
        i += 1;
        if len == 128 {
            break;
        }
        if len < 128 {
            let n = len as usize + 1;
            if i + n > data.len() {
                break;
            }
            out.extend_from_slice(&data[i..i + n]);
            i += n;
        } else {
            let n = 257 - len as usize;
            if i >= data.len() {
                break;
            }
            out.extend(std::iter::repeat(data[i]).take(n));
            i += 1;
        }
    }
    out
}

enum Cs {
    Gray,
    Rgb,
    Cmyk,
    Indexed { base: Box<Cs>, palette: Vec<u8> },
    Unknown,
}

fn cs_note(doc: &Document, dict: &Dictionary) -> String {
    let cs = dict
        .get(b"ColorSpace")
        .or_else(|_| dict.get(b"CS"))
        .ok()
        .map(|o| resolve(doc, o));
    match classify_cs(doc, cs) {
        Cs::Gray => "DeviceGray".into(),
        Cs::Rgb => "DeviceRGB".into(),
        Cs::Cmyk => "DeviceCMYK".into(),
        Cs::Indexed { .. } => "Indexed".into(),
        Cs::Unknown => "color".into(),
    }
}

fn classify_cs(doc: &Document, cs: Option<&Object>) -> Cs {
    let Some(cs) = cs else {
        return Cs::Unknown;
    };
    match cs {
        Object::Name(n) => match n.as_slice() {
            b"DeviceGray" | b"CalGray" | b"G" => Cs::Gray,
            b"DeviceRGB" | b"CalRGB" | b"RGB" => Cs::Rgb,
            b"DeviceCMYK" | b"CMYK" => Cs::Cmyk,
            _ => Cs::Unknown,
        },
        Object::Array(a) => {
            let head = a.first().map(|o| resolve(doc, o));
            match head {
                Some(Object::Name(n)) => match n.as_slice() {
                    b"ICCBased" => {
                        let comps = a
                            .get(1)
                            .map(|o| resolve(doc, o))
                            .and_then(|o| match o {
                                Object::Stream(s) => dict_int(doc, &s.dict, b"N"),
                                _ => None,
                            })
                            .unwrap_or(0);
                        match comps {
                            1 => Cs::Gray,
                            3 => Cs::Rgb,
                            4 => Cs::Cmyk,
                            _ => Cs::Unknown,
                        }
                    }
                    b"CalRGB" => Cs::Rgb,
                    b"CalGray" => Cs::Gray,
                    b"Indexed" | b"I" => {
                        let base = Box::new(classify_cs(doc, a.get(1).map(|o| resolve(doc, o))));
                        let palette = a
                            .get(3)
                            .map(|o| lookup_bytes(doc, o))
                            .unwrap_or_default();
                        Cs::Indexed { base, palette }
                    }
                    _ => Cs::Unknown,
                },
                _ => Cs::Unknown,
            }
        }
        _ => Cs::Unknown,
    }
}

fn lookup_bytes(doc: &Document, o: &Object) -> Vec<u8> {
    match resolve(doc, o) {
        Object::String(s, _) => s.clone(),
        Object::Stream(s) => s
            .decompressed_content()
            .unwrap_or_else(|_| s.content.clone()),
        _ => Vec::new(),
    }
}

/// Read predictor settings from /DecodeParms (defaults per PDF spec).
fn predictor_params(
    doc: &Document,
    dict: &Dictionary,
    default_columns: u32,
    img_bpc: u32,
) -> (i64, usize, usize, usize) {
    let dp = dict
        .get(b"DecodeParms")
        .or_else(|_| dict.get(b"DP"))
        .ok()
        .map(|o| resolve(doc, o));
    let params: Option<&Dictionary> = match dp {
        Some(Object::Dictionary(d)) => Some(d),
        // With a filter array, DecodeParms is a parallel array; the predictor
        // params live in whichever dict carries /Predictor.
        Some(Object::Array(a)) => a.iter().map(|o| resolve(doc, o)).find_map(|o| match o {
            Object::Dictionary(d) if d.get(b"Predictor").is_ok() => Some(d),
            _ => None,
        }),
        _ => None,
    };
    let Some(pd) = params else {
        return (1, 1, default_columns as usize, img_bpc as usize);
    };
    let get = |k: &[u8]| pd.get(k).ok().map(|o| resolve(doc, o)).and_then(as_int);
    (
        get(b"Predictor").unwrap_or(1),
        get(b"Colors").unwrap_or(1) as usize,
        get(b"Columns").unwrap_or(1) as usize,
        get(b"BitsPerComponent").unwrap_or(img_bpc as i64) as usize,
    )
}

/// Reverse a PNG (Predictor >= 10) or TIFF (Predictor == 2) predictor.
fn unpredict(doc: &Document, dict: &Dictionary, data: Vec<u8>, w: u32, bpc: u32) -> Vec<u8> {
    let (predictor, colors, columns, pbpc) = predictor_params(doc, dict, w, bpc);
    if predictor < 2 {
        return data; // 1 or absent: no prediction
    }
    let colors = colors.max(1);
    let columns = columns.max(1);
    let pbpc = pbpc.max(1);
    let bpp = (colors * pbpc).div_ceil(8).max(1); // bytes between a pixel and its left neighbour
    let row_len = (columns * colors * pbpc).div_ceil(8);
    if row_len == 0 {
        return data;
    }

    if predictor == 2 {
        // TIFF predictor 2: horizontal differencing (byte-wise, 8-bit components).
        let mut out = data;
        let rows = out.len() / row_len;
        for r in 0..rows {
            let base = r * row_len;
            for i in bpp..row_len {
                out[base + i] = out[base + i].wrapping_add(out[base + i - bpp]);
            }
        }
        return out;
    }

    // PNG predictors: each row is prefixed with a filter-type byte.
    let stride = row_len + 1;
    let rows = data.len() / stride;
    let mut out = vec![0u8; rows * row_len];
    for r in 0..rows {
        let in_base = r * stride;
        let filter = data[in_base];
        let out_base = r * row_len;
        let prev_base = out_base.wrapping_sub(row_len); // valid only when r > 0
        for i in 0..row_len {
            let x = data[in_base + 1 + i];
            let a = if i >= bpp { out[out_base + i - bpp] } else { 0 };
            let b = if r > 0 { out[prev_base + i] } else { 0 };
            let c = if r > 0 && i >= bpp { out[prev_base + i - bpp] } else { 0 };
            out[out_base + i] = match filter {
                0 => x,
                1 => x.wrapping_add(a),
                2 => x.wrapping_add(b),
                3 => x.wrapping_add(((a as u16 + b as u16) / 2) as u8),
                4 => x.wrapping_add(paeth(a, b, c)),
                _ => x,
            };
        }
    }
    out
}

fn paeth(a: u8, b: u8, c: u8) -> u8 {
    let p = a as i32 + b as i32 - c as i32;
    let pa = (p - a as i32).abs();
    let pb = (p - b as i32).abs();
    let pc = (p - c as i32).abs();
    if pa <= pb && pa <= pc {
        a
    } else if pb <= pc {
        b
    } else {
        c
    }
}

fn build_png(
    doc: &Document,
    dict: &Dictionary,
    samples: &[u8],
    w: u32,
    h: u32,
    bpc: u32,
) -> Option<(Vec<u8>, String)> {
    if w == 0 || h == 0 {
        return None;
    }
    let cs = dict
        .get(b"ColorSpace")
        .or_else(|_| dict.get(b"CS"))
        .ok()
        .map(|o| resolve(doc, o));
    match classify_cs(doc, cs) {
        Cs::Gray if bpc == 8 => encode_gray8(samples, w, h).map(|p| (p, "DeviceGray 8-bit".into())),
        Cs::Gray if bpc == 1 => {
            let g = expand_1bit_gray(samples, w, h);
            encode_gray8(&g, w, h).map(|p| (p, "DeviceGray 1-bit".into()))
        }
        Cs::Rgb if bpc == 8 => encode_rgb8(samples, w, h).map(|p| (p, "DeviceRGB 8-bit".into())),
        Cs::Cmyk if bpc == 8 => encode_cmyk8(samples, w, h).map(|p| (p, "DeviceCMYK → RGB".into())),
        Cs::Indexed { base, palette } if bpc == 8 => {
            let rgb = expand_indexed(samples, w, h, &base, &palette)?;
            encode_rgb8(&rgb, w, h).map(|p| (p, "Indexed → RGB".into()))
        }
        _ => None,
    }
}

fn encode_gray8(data: &[u8], w: u32, h: u32) -> Option<Vec<u8>> {
    let need = (w as usize) * (h as usize);
    if data.len() < need {
        return None;
    }
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, w, h);
        enc.set_color(png::ColorType::Grayscale);
        enc.set_depth(png::BitDepth::Eight);
        let mut wr = enc.write_header().ok()?;
        wr.write_image_data(&data[..need]).ok()?;
    }
    Some(out)
}

fn encode_rgb8(data: &[u8], w: u32, h: u32) -> Option<Vec<u8>> {
    let need = (w as usize) * (h as usize) * 3;
    if data.len() < need {
        return None;
    }
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, w, h);
        enc.set_color(png::ColorType::Rgb);
        enc.set_depth(png::BitDepth::Eight);
        let mut wr = enc.write_header().ok()?;
        wr.write_image_data(&data[..need]).ok()?;
    }
    Some(out)
}

/// Naive DeviceCMYK -> RGB (no ICC profile): r = (255-c)(255-k)/255, etc.
fn encode_cmyk8(data: &[u8], w: u32, h: u32) -> Option<Vec<u8>> {
    let n = (w as usize) * (h as usize);
    if data.len() < n * 4 {
        return None;
    }
    let mut rgb = Vec::with_capacity(n * 3);
    for px in data[..n * 4].chunks_exact(4) {
        let (c, m, y, k) = (px[0] as u32, px[1] as u32, px[2] as u32, px[3] as u32);
        rgb.push(((255 - c) * (255 - k) / 255) as u8);
        rgb.push(((255 - m) * (255 - k) / 255) as u8);
        rgb.push(((255 - y) * (255 - k) / 255) as u8);
    }
    encode_rgb8(&rgb, w, h)
}

fn expand_1bit_gray(data: &[u8], w: u32, h: u32) -> Vec<u8> {
    let row_bytes = ((w + 7) / 8) as usize;
    let mut out = Vec::with_capacity((w * h) as usize);
    for y in 0..h as usize {
        for x in 0..w as usize {
            let byte = data.get(y * row_bytes + x / 8).copied().unwrap_or(0);
            let bit = (byte >> (7 - (x % 8))) & 1;
            out.push(if bit == 1 { 255 } else { 0 });
        }
    }
    out
}

fn expand_indexed(samples: &[u8], w: u32, h: u32, base: &Cs, palette: &[u8]) -> Option<Vec<u8>> {
    let ncomp = match base {
        Cs::Gray => 1usize,
        Cs::Rgb => 3usize,
        _ => return None,
    };
    let n = (w as usize) * (h as usize);
    if samples.len() < n {
        return None;
    }
    let mut out = Vec::with_capacity(n * 3);
    for &idx in &samples[..n] {
        let off = idx as usize * ncomp;
        if ncomp == 1 {
            let g = palette.get(off).copied().unwrap_or(0);
            out.extend_from_slice(&[g, g, g]);
        } else {
            let r = palette.get(off).copied().unwrap_or(0);
            let g = palette.get(off + 1).copied().unwrap_or(0);
            let b = palette.get(off + 2).copied().unwrap_or(0);
            out.extend_from_slice(&[r, g, b]);
        }
    }
    Some(out)
}

// --- fonts -----------------------------------------------------------------

struct FontRef {
    id: ObjectId,
    key: &'static str,
    base: String,
}

fn collect_font_files(doc: &Document) -> Vec<FontRef> {
    let mut seen: BTreeSet<ObjectId> = BTreeSet::new();
    let mut out = Vec::new();
    for obj in doc.objects.values() {
        let dict = match obj {
            Object::Dictionary(d) => d,
            Object::Stream(s) => &s.dict,
            _ => continue,
        };
        let base = dict
            .get(b"FontName")
            .ok()
            .and_then(|o| match resolve(doc, o) {
                Object::Name(n) => Some(name_str(n)),
                _ => None,
            })
            .map(|s| s.split('+').next_back().unwrap_or(&s).to_string());

        for key in ["FontFile", "FontFile2", "FontFile3"] {
            if let Ok(v) = dict.get(key.as_bytes()) {
                if let Object::Reference(id) = v {
                    if seen.insert(*id) {
                        out.push(FontRef {
                            id: *id,
                            key,
                            base: base.clone().unwrap_or_default(),
                        });
                    }
                }
            }
        }
    }
    out
}

fn extract_font(doc: &Document, fr: &FontRef, n: usize) -> Option<Asset> {
    let stream = match doc.get_object(fr.id) {
        Ok(Object::Stream(s)) => s,
        _ => return None,
    };
    let mut bytes = stream
        .decompressed_content()
        .unwrap_or_else(|_| stream.content.clone());

    let (ext, mime, kind_note) = match fr.key {
        "FontFile" => ("pfb", "application/x-font-type1", "Type 1".to_string()),
        // Usually TrueType, but some producers put an OpenType (OTTO/CFF) sfnt
        // in FontFile2 — name it by its actual signature.
        "FontFile2" if bytes.starts_with(b"OTTO") => {
            ("otf", "font/otf", "OpenType".to_string())
        }
        "FontFile2" => ("ttf", "font/ttf", "TrueType".to_string()),
        _ => {
            let sub = stream
                .dict
                .get(b"Subtype")
                .ok()
                .and_then(|o| match o {
                    Object::Name(nm) => Some(name_str(nm)),
                    _ => None,
                })
                .unwrap_or_default();
            if sub == "OpenType" {
                ("otf", "font/otf", "OpenType".to_string())
            } else {
                // Bare CFF (Type1C / CIDFontType0C): wrap into an OpenType sfnt
                // so it's a normal, installable font instead of a raw .cff.
                match cff::cff_to_otf(&bytes) {
                    Some(otf) => {
                        bytes = otf;
                        ("otf", "font/otf", "CFF → OpenType".to_string())
                    }
                    None => ("cff", "font/otf", if sub.is_empty() { "CFF".into() } else { sub }),
                }
            }
        }
    };

    let stem = if fr.base.is_empty() {
        format!("font-{n}")
    } else {
        sanitize(&fr.base)
    };

    Some(Asset {
        kind: "font".into(),
        name: format!("{stem}.{ext}"),
        mime: mime.into(),
        width: 0,
        height: 0,
        note: kind_note,
        bytes,
    })
}

fn sanitize(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect()
}
