//! Wrap a bare CFF font program (as found in a PDF FontFile3 / Type1C stream)
//! into a valid OpenType (`OTTO`) sfnt, so it can be installed and previewed
//! like a normal font. The CFF outlines are embedded untouched; we synthesise
//! the sibling tables (head/hhea/hmtx/maxp/name/OS-2/post/cmap) that a
//! standalone font requires.
//!
//! Caveats (documented for callers): PDF-embedded CFFs are usually subset and
//! carry no character map, so the synthesised cmap is best-effort from the CFF
//! encoding. Glyph advance widths are recovered from the charstrings where
//! possible, otherwise a default is used.

include!("cff_unicode_table.rs");

/// Wrap a bare CFF into an OpenType font. Returns None if the bytes don't look
/// like a parseable CFF (caller then keeps the raw `.cff`).
pub fn cff_to_otf(cff: &[u8]) -> Option<Vec<u8>> {
    let info = CffInfo::parse(cff)?;
    if info.num_glyphs == 0 {
        return None;
    }
    Some(build_otf(cff, &info))
}

struct CffInfo {
    num_glyphs: u16,
    bbox: [i32; 4],
    units_per_em: u16,
    ps_name: String,
    widths: Vec<u16>,            // advance width per glyph, in font units
    uni_to_gid: Vec<(u16, u16)>, // Unicode -> glyph, from the CFF charset
}

// --- CFF reading -----------------------------------------------------------

/// An INDEX: returns the byte ranges of each entry and the offset just past it.
fn read_index(data: &[u8], pos: usize) -> Option<(Vec<(usize, usize)>, usize)> {
    if pos + 2 > data.len() {
        return None;
    }
    let count = u16::from_be_bytes([data[pos], data[pos + 1]]) as usize;
    if count == 0 {
        return Some((Vec::new(), pos + 2));
    }
    let off_size = *data.get(pos + 2)? as usize;
    if off_size == 0 || off_size > 4 {
        return None;
    }
    let off_base = pos + 3;
    // read offsets[count+1]
    let mut offs = Vec::with_capacity(count + 1);
    for i in 0..=count {
        let start = off_base + i * off_size;
        let bytes = data.get(start..start + off_size)?;
        offs.push(bytes.iter().fold(0usize, |a, &b| (a << 8) | b as usize));
    }
    let data_base = off_base + (count + 1) * off_size - 1; // offsets are 1-based
    let mut entries = Vec::with_capacity(count);
    for i in 0..count {
        let s = data_base + offs[i];
        let e = data_base + offs[i + 1];
        if e > data.len() || s > e {
            return None;
        }
        entries.push((s, e));
    }
    Some((entries, data_base + offs[count]))
}

/// Parse a CFF DICT into (operator, operands) pairs. Two-byte operators
/// (escape 12 xx) are encoded as 1200 + xx.
fn parse_dict(data: &[u8]) -> Vec<(u16, Vec<f64>)> {
    let mut out = Vec::new();
    let mut operands: Vec<f64> = Vec::new();
    let mut i = 0;
    while i < data.len() {
        let b = data[i];
        match b {
            0..=21 => {
                let op = if b == 12 {
                    i += 1;
                    1200 + *data.get(i).unwrap_or(&0) as u16
                } else {
                    b as u16
                };
                out.push((op, std::mem::take(&mut operands)));
                i += 1;
            }
            28 => {
                let v = i16::from_be_bytes([
                    *data.get(i + 1).unwrap_or(&0),
                    *data.get(i + 2).unwrap_or(&0),
                ]) as f64;
                operands.push(v);
                i += 3;
            }
            29 => {
                let v = i32::from_be_bytes([
                    *data.get(i + 1).unwrap_or(&0),
                    *data.get(i + 2).unwrap_or(&0),
                    *data.get(i + 3).unwrap_or(&0),
                    *data.get(i + 4).unwrap_or(&0),
                ]) as f64;
                operands.push(v);
                i += 5;
            }
            30 => {
                // real number, nibble-encoded
                let (val, next) = parse_real(data, i + 1);
                operands.push(val);
                i = next;
            }
            32..=246 => {
                operands.push(b as f64 - 139.0);
                i += 1;
            }
            247..=250 => {
                let b1 = *data.get(i + 1).unwrap_or(&0) as f64;
                operands.push((b as f64 - 247.0) * 256.0 + b1 + 108.0);
                i += 2;
            }
            251..=254 => {
                let b1 = *data.get(i + 1).unwrap_or(&0) as f64;
                operands.push(-(b as f64 - 251.0) * 256.0 - b1 - 108.0);
                i += 2;
            }
            _ => i += 1, // 22..=27, 31, 255 are reserved in DICTs
        }
    }
    out
}

fn parse_real(data: &[u8], mut i: usize) -> (f64, usize) {
    let mut s = String::new();
    'outer: while i < data.len() {
        let byte = data[i];
        i += 1;
        for nibble in [byte >> 4, byte & 0xf] {
            match nibble {
                0..=9 => s.push((b'0' + nibble) as char),
                0xa => s.push('.'),
                0xb => s.push('E'),
                0xc => s.push_str("E-"),
                0xe => s.push('-'),
                0xf => break 'outer,
                _ => {}
            }
        }
    }
    (s.parse().unwrap_or(0.0), i)
}

fn find_op(dict: &[(u16, Vec<f64>)], op: u16) -> Option<&Vec<f64>> {
    dict.iter().find(|(o, _)| *o == op).map(|(_, v)| v)
}

impl CffInfo {
    fn parse(cff: &[u8]) -> Option<Self> {
        let hdr_size = *cff.get(2)? as usize;
        let (name_entries, p1) = read_index(cff, hdr_size)?;
        let ps_name = name_entries
            .first()
            .map(|&(s, e)| String::from_utf8_lossy(&cff[s..e]).into_owned())
            .unwrap_or_default();
        let (top_entries, p2) = read_index(cff, p1)?;
        let (ts, te) = *top_entries.first()?;
        let top = parse_dict(&cff[ts..te]);

        // String INDEX then Global Subr INDEX follow the Top DICT INDEX.
        let (string_entries, p3) = read_index(cff, p2).unwrap_or((Vec::new(), p2));
        let gsubrs = read_index(cff, p3).map(|(e, _)| e).unwrap_or_default();

        // FontMatrix -> unitsPerEm (default 1000).
        let units_per_em = find_op(&top, 1207)
            .and_then(|m| m.first())
            .map(|&sx| if sx > 0.0 { (1.0 / sx).round() as u16 } else { 1000 })
            .filter(|&u| (16..=16384).contains(&u))
            .unwrap_or(1000);

        let bbox = find_op(&top, 5)
            .filter(|b| b.len() == 4)
            .map(|b| [b[0] as i32, b[1] as i32, b[2] as i32, b[3] as i32])
            .unwrap_or([0, 0, units_per_em as i32, units_per_em as i32]);

        let cs_off = *find_op(&top, 17)?.first()? as usize;
        let (charstrings, _) = read_index(cff, cs_off)?;
        let num_glyphs = charstrings.len().min(0xFFFF) as u16;

        let is_cid = find_op(&top, 1230).is_some();

        // Private DICT -> nominal/default widths. For CID, take the first
        // FDArray font dict's Private as an approximation.
        let (mut nominal_w, mut default_w) = (0.0f64, 0.0f64);
        let private = if is_cid {
            find_op(&top, 1236)
                .and_then(|v| v.first())
                .and_then(|&fd_off| read_index(cff, fd_off as usize).flatten_first(cff))
        } else {
            find_op(&top, 18).filter(|p| p.len() == 2).and_then(|p| {
                let (size, off) = (p[0] as usize, p[1] as usize);
                cff.get(off..off + size).map(|s| s.to_vec())
            })
        };
        if let Some(priv_bytes) = &private {
            let pd = parse_dict(priv_bytes);
            default_w = find_op(&pd, 20).and_then(|v| v.first()).copied().unwrap_or(0.0);
            nominal_w = find_op(&pd, 21).and_then(|v| v.first()).copied().unwrap_or(0.0);
        }

        // Local subrs live in the (non-CID) Private DICT, at an offset relative
        // to the Private DICT's start.
        let lsubrs = if !is_cid {
            find_op(&top, 18)
                .filter(|p| p.len() == 2)
                .and_then(|p| {
                    let (size, off) = (p[0] as usize, p[1] as usize);
                    let pd = parse_dict(cff.get(off..off + size)?);
                    let rel = *find_op(&pd, 19)?.first()? as usize;
                    read_index(cff, off + rel).map(|(e, _)| e)
                })
                .unwrap_or_default()
        } else {
            Vec::new()
        };

        let ctx = WidthCtx {
            cff,
            gsubrs: &gsubrs,
            lsubrs: &lsubrs,
            gbias: bias(gsubrs.len()),
            lbias: bias(lsubrs.len()),
            nominal: nominal_w,
            default: default_w,
        };
        let widths = charstrings
            .iter()
            .map(|&(s, e)| {
                let mut stack = Vec::new();
                match ctx.scan((s, e), &mut stack, 0) {
                    Some(w) => clamp_w(w, default_w),
                    None => clamp_w(default_w, default_w),
                }
            })
            .collect();

        // Build a Unicode cmap from the charset (gid -> glyph name -> Unicode).
        // This is the reliable source for subset PDF fonts, which keep standard
        // or uniXXXX glyph names but rarely a usable built-in encoding.
        let uni_to_gid = match find_op(&top, 15).and_then(|v| v.first()).map(|&o| o as usize) {
            Some(off) if off > 2 => {
                let sids = parse_charset(cff, off, num_glyphs);
                build_unicode_map(&sids, &string_entries, cff)
            }
            _ => Vec::new(), // predefined charsets: skip
        };

        Some(CffInfo {
            num_glyphs,
            bbox,
            units_per_em,
            ps_name,
            widths,
            uni_to_gid,
        })
    }
}

// small helper so the CID branch reads cleanly
trait FlattenFirst {
    fn flatten_first(self, cff: &[u8]) -> Option<Vec<u8>>;
}
impl FlattenFirst for Option<(Vec<(usize, usize)>, usize)> {
    fn flatten_first(self, cff: &[u8]) -> Option<Vec<u8>> {
        let (entries, _) = self?;
        let (s, e) = *entries.first()?;
        let fd = parse_dict(&cff[s..e]);
        let p = find_op(&fd, 18).filter(|p| p.len() == 2)?;
        let (size, off) = (p[0] as usize, p[1] as usize);
        cff.get(off..off + size).map(|s| s.to_vec())
    }
}

fn bias(n: usize) -> i32 {
    if n < 1240 {
        107
    } else if n < 33900 {
        1131
    } else {
        32768
    }
}

/// Minimal Type 2 charstring interpreter that tracks only the operand stack and
/// follows subroutine calls, stopping at the first width-bearing operator. The
/// width (if present) is the extra leading operand, relative to nominalWidthX.
struct WidthCtx<'a> {
    cff: &'a [u8],
    gsubrs: &'a [(usize, usize)],
    lsubrs: &'a [(usize, usize)],
    gbias: i32,
    lbias: i32,
    nominal: f64,
    default: f64,
}

impl WidthCtx<'_> {
    /// Returns Some(width) once a width-bearing operator is reached, else None
    /// (caller continues scanning after a subr return).
    fn scan(&self, range: (usize, usize), stack: &mut Vec<f64>, depth: u32) -> Option<f64> {
        if depth > 10 {
            return Some(self.default);
        }
        let cs = &self.cff[range.0..range.1];
        let w_if = |present: bool, stack: &[f64]| {
            if present {
                self.nominal + stack[0]
            } else {
                self.default
            }
        };
        let mut i = 0;
        while i < cs.len() {
            let b = cs[i];
            match b {
                1 | 3 | 18 | 23 | 19 | 20 => return Some(w_if(stack.len() % 2 == 1, stack)),
                21 => return Some(w_if(stack.len() > 2, stack)),
                22 | 4 => return Some(w_if(stack.len() > 1, stack)),
                14 => return Some(w_if(stack.len() == 1 || stack.len() == 5, stack)),
                10 | 29 => {
                    let (subrs, bias) = if b == 10 {
                        (self.lsubrs, self.lbias)
                    } else {
                        (self.gsubrs, self.gbias)
                    };
                    if let Some(idx) = stack.pop() {
                        let n = idx as i32 + bias;
                        if let Some(&r) = usize::try_from(n).ok().and_then(|u| subrs.get(u)) {
                            if let Some(w) = self.scan(r, stack, depth + 1) {
                                return Some(w);
                            }
                        }
                    }
                    i += 1;
                }
                11 => return None, // return from subr
                28 => {
                    stack.push(i16::from_be_bytes([cs[i + 1], cs[i + 2]]) as f64);
                    i += 3;
                }
                255 => {
                    let v = i32::from_be_bytes([cs[i + 1], cs[i + 2], cs[i + 3], cs[i + 4]]);
                    stack.push(v as f64 / 65536.0);
                    i += 5;
                }
                32..=246 => {
                    stack.push(b as f64 - 139.0);
                    i += 1;
                }
                247..=250 => {
                    stack.push((b as f64 - 247.0) * 256.0 + cs[i + 1] as f64 + 108.0);
                    i += 2;
                }
                251..=254 => {
                    stack.push(-(b as f64 - 251.0) * 256.0 - cs[i + 1] as f64 - 108.0);
                    i += 2;
                }
                12 => {
                    stack.clear(); // two-byte operator: clears the stack
                    i += 2;
                }
                _ => i += 1,
            }
        }
        None
    }
}

fn clamp_w(w: f64, default: f64) -> u16 {
    let w = if w.is_finite() { w } else { default };
    w.clamp(0.0, 65535.0) as u16
}

/// Parse the CFF charset (format 0/1/2) into a glyph -> SID map. gid 0 is
/// always .notdef (SID 0); the table covers gids 1..num_glyphs.
fn parse_charset(cff: &[u8], off: usize, num_glyphs: u16) -> Vec<u16> {
    let n = num_glyphs as usize;
    let mut sids = vec![0u16; n];
    let Some(&fmt) = cff.get(off) else {
        return sids;
    };
    let rd16 = |p: usize| -> Option<u16> {
        cff.get(p..p + 2).map(|b| u16::from_be_bytes([b[0], b[1]]))
    };
    let mut gid = 1usize;
    let mut p = off + 1;
    match fmt {
        0 => {
            while gid < n {
                sids[gid] = rd16(p).unwrap_or(0);
                gid += 1;
                p += 2;
            }
        }
        1 | 2 => {
            while gid < n {
                let Some(first) = rd16(p) else { break };
                let (n_left, adv) = if fmt == 1 {
                    (*cff.get(p + 2).unwrap_or(&0) as usize, 3)
                } else {
                    (rd16(p + 2).unwrap_or(0) as usize, 4)
                };
                p += adv;
                for k in 0..=n_left {
                    if gid >= n {
                        break;
                    }
                    sids[gid] = first.wrapping_add(k as u16);
                    gid += 1;
                }
            }
        }
        _ => {}
    }
    sids
}

fn build_unicode_map(sids: &[u16], strings: &[(usize, usize)], cff: &[u8]) -> Vec<(u16, u16)> {
    let mut out = Vec::new();
    for (gid, &sid) in sids.iter().enumerate().skip(1) {
        if let Some(u) = sid_to_unicode(sid, strings, cff) {
            if u != 0 && u != 0xFFFF {
                out.push((u, gid as u16));
            }
        }
    }
    out
}

fn sid_to_unicode(sid: u16, strings: &[(usize, usize)], cff: &[u8]) -> Option<u16> {
    if (sid as usize) < STD_UNICODE.len() {
        let u = STD_UNICODE[sid as usize];
        return (u != 0).then_some(u);
    }
    let (s, e) = *strings.get(sid as usize - STD_UNICODE.len())?;
    let name = std::str::from_utf8(cff.get(s..e)?).ok()?;
    parse_uni_name(name)
}

/// Map "uniXXXX" / "uXXXX".."uXXXXXX" glyph names to a BMP codepoint.
fn parse_uni_name(name: &str) -> Option<u16> {
    if let Some(hex) = name.get(..7).filter(|_| name.starts_with("uni")).map(|s| &s[3..]) {
        return u16::from_str_radix(hex, 16).ok();
    }
    if let Some(hex) = name.strip_prefix('u') {
        if (4..=6).contains(&hex.len()) && hex.bytes().all(|b| b.is_ascii_hexdigit()) {
            return u32::from_str_radix(hex, 16).ok().filter(|&c| c <= 0xFFFF).map(|c| c as u16);
        }
    }
    None
}

// --- OTF writing -----------------------------------------------------------

fn be16(v: u16, out: &mut Vec<u8>) {
    out.extend_from_slice(&v.to_be_bytes());
}
fn be32(v: u32, out: &mut Vec<u8>) {
    out.extend_from_slice(&v.to_be_bytes());
}

fn build_otf(cff: &[u8], info: &CffInfo) -> Vec<u8> {
    let upem = info.units_per_em;
    let ng = info.num_glyphs;
    let [x_min, y_min, x_max, y_max] = info.bbox;
    let ascender = if y_max > 0 { y_max } else { (upem as i32 * 4) / 5 };
    let descender = if y_min < 0 { y_min } else { -(upem as i32 / 5) };
    let max_adv = info.widths.iter().copied().max().unwrap_or(upem);
    let family = strip_subset(&info.ps_name);

    let mut tables: Vec<([u8; 4], Vec<u8>)> = Vec::new();

    // head
    let mut head = Vec::new();
    be16(1, &mut head);
    be16(0, &mut head);
    be32(0x0001_0000, &mut head); // fontRevision
    be32(0, &mut head); // checkSumAdjustment (patched later)
    be32(0x5F0F_3CF5, &mut head); // magic
    be16(0x000B, &mut head); // flags
    be16(upem, &mut head);
    head.extend_from_slice(&[0u8; 8]); // created
    head.extend_from_slice(&[0u8; 8]); // modified
    head.extend_from_slice(&(x_min as i16).to_be_bytes());
    head.extend_from_slice(&(y_min as i16).to_be_bytes());
    head.extend_from_slice(&(x_max as i16).to_be_bytes());
    head.extend_from_slice(&(y_max as i16).to_be_bytes());
    be16(0, &mut head); // macStyle
    be16(8, &mut head); // lowestRecPPEM
    head.extend_from_slice(&2i16.to_be_bytes()); // fontDirectionHint
    be16(0, &mut head); // indexToLocFormat
    be16(0, &mut head); // glyphDataFormat
    tables.push((*b"head", head));

    // hhea
    let mut hhea = Vec::new();
    be16(1, &mut hhea);
    be16(0, &mut hhea);
    hhea.extend_from_slice(&(ascender as i16).to_be_bytes());
    hhea.extend_from_slice(&(descender as i16).to_be_bytes());
    hhea.extend_from_slice(&0i16.to_be_bytes()); // lineGap
    be16(max_adv, &mut hhea);
    hhea.extend_from_slice(&0i16.to_be_bytes()); // minLeftSideBearing
    hhea.extend_from_slice(&0i16.to_be_bytes()); // minRightSideBearing
    hhea.extend_from_slice(&(x_max as i16).to_be_bytes()); // xMaxExtent
    hhea.extend_from_slice(&1i16.to_be_bytes()); // caretSlopeRise
    hhea.extend_from_slice(&0i16.to_be_bytes()); // caretSlopeRun
    hhea.extend_from_slice(&0i16.to_be_bytes()); // caretOffset
    hhea.extend_from_slice(&[0u8; 8]); // 4 reserved
    hhea.extend_from_slice(&0i16.to_be_bytes()); // metricDataFormat
    be16(ng, &mut hhea); // numberOfHMetrics
    tables.push((*b"hhea", hhea));

    // hmtx
    let mut hmtx = Vec::new();
    for g in 0..ng as usize {
        be16(*info.widths.get(g).unwrap_or(&max_adv), &mut hmtx);
        be16(0, &mut hmtx); // lsb
    }
    tables.push((*b"hmtx", hmtx));

    // maxp v0.5
    let mut maxp = Vec::new();
    be32(0x0000_5000, &mut maxp);
    be16(ng, &mut maxp);
    tables.push((*b"maxp", maxp));

    // OS/2 v4
    tables.push((*b"OS/2", build_os2(upem, ascender, descender, max_adv)));

    // post v3.0
    let mut post = Vec::new();
    be32(0x0003_0000, &mut post);
    be32(0, &mut post); // italicAngle
    post.extend_from_slice(&(-(upem as i16) / 10).to_be_bytes()); // underlinePosition
    post.extend_from_slice(&(upem as i16 / 20).to_be_bytes()); // underlineThickness
    be32(0, &mut post); // isFixedPitch
    be32(0, &mut post);
    be32(0, &mut post);
    be32(0, &mut post);
    be32(0, &mut post);
    tables.push((*b"post", post));

    // name
    tables.push((*b"name", build_name(&family)));

    // cmap
    tables.push((*b"cmap", build_cmap(&info.uni_to_gid)));

    // CFF
    tables.push((*b"CFF ", cff.to_vec()));

    assemble_sfnt(tables)
}

fn build_os2(upem: u16, ascender: i32, descender: i32, max_adv: u16) -> Vec<u8> {
    let mut t = Vec::new();
    be16(4, &mut t); // version
    t.extend_from_slice(&((max_adv / 2) as i16).to_be_bytes()); // xAvgCharWidth
    be16(400, &mut t); // usWeightClass
    be16(5, &mut t); // usWidthClass
    be16(0, &mut t); // fsType
    let sub = (upem as i16) * 2 / 3;
    for v in [sub, sub, 0, 0, sub, sub, 0, (upem as i16) / 2] {
        t.extend_from_slice(&v.to_be_bytes()); // subscript/superscript X/Y size+offset
    }
    t.extend_from_slice(&((upem as i16) / 20).to_be_bytes()); // yStrikeoutSize
    t.extend_from_slice(&((upem as i16) / 4).to_be_bytes()); // yStrikeoutPosition
    be16(0, &mut t); // sFamilyClass
    t.extend_from_slice(&[0u8; 10]); // panose
    be32(0, &mut t); // ulUnicodeRange1
    be32(0, &mut t);
    be32(0, &mut t);
    be32(0, &mut t);
    t.extend_from_slice(b"PDFX"); // achVendID
    be16(0x0040, &mut t); // fsSelection: REGULAR
    be16(0x20, &mut t); // usFirstCharIndex
    be16(0xFFFF, &mut t); // usLastCharIndex
    t.extend_from_slice(&(ascender as i16).to_be_bytes()); // sTypoAscender
    t.extend_from_slice(&(descender as i16).to_be_bytes()); // sTypoDescender
    be16(0, &mut t); // sTypoLineGap
    be16(ascender.max(0) as u16, &mut t); // usWinAscent
    be16((-descender).max(0) as u16, &mut t); // usWinDescent
    be32(0, &mut t); // ulCodePageRange1
    be32(0, &mut t); // ulCodePageRange2
    t.extend_from_slice(&((upem as i16) / 2).to_be_bytes()); // sxHeight
    t.extend_from_slice(&((ascender as i16) * 7 / 10).to_be_bytes()); // sCapHeight
    be16(0, &mut t); // usDefaultChar
    be16(0x20, &mut t); // usBreakChar
    be16(0, &mut t); // usMaxContext
    t
}

fn build_name(family: &str) -> Vec<u8> {
    // nameIDs: 1 family, 2 subfamily, 3 unique, 4 full, 6 postscript.
    let ps = family.replace(' ', "");
    let entries: [(u16, &str); 5] = [
        (1, family),
        (2, "Regular"),
        (3, &ps),
        (4, family),
        (6, &ps),
    ];
    // Build storage (UTF-16BE) and records for platform (3,1,0x409).
    let mut storage = Vec::new();
    let mut records = Vec::new();
    for (id, s) in entries {
        let utf16: Vec<u8> = s.encode_utf16().flat_map(|u| u.to_be_bytes()).collect();
        let offset = storage.len() as u16;
        let len = utf16.len() as u16;
        storage.extend_from_slice(&utf16);
        records.push((3u16, 1u16, 0x0409u16, id, len, offset));
    }
    records.sort_by_key(|r| (r.0, r.1, r.2, r.3));

    let mut t = Vec::new();
    be16(0, &mut t); // format
    be16(records.len() as u16, &mut t);
    let string_offset = 6 + records.len() as u16 * 12;
    be16(string_offset, &mut t);
    for (p, e, l, id, len, off) in records {
        be16(p, &mut t);
        be16(e, &mut t);
        be16(l, &mut t);
        be16(id, &mut t);
        be16(len, &mut t);
        be16(off, &mut t);
    }
    t.extend_from_slice(&storage);
    t
}

/// cmap with a single (3,1) format-4 subtable. One segment per mapped code
/// keeps the builder simple; an empty mapping yields just the required
/// terminating segment.
fn build_cmap(uni_to_gid: &[(u16, u16)]) -> Vec<u8> {
    let mut pairs: Vec<(u16, u16)> = uni_to_gid.to_vec();
    pairs.sort_by_key(|&(c, _)| c);
    pairs.dedup_by_key(|p| p.0);

    // segments: one per pair (start==end), plus terminator 0xFFFF
    let mut end_codes: Vec<u16> = pairs.iter().map(|&(c, _)| c).collect();
    let mut start_codes: Vec<u16> = pairs.iter().map(|&(c, _)| c).collect();
    let mut id_deltas: Vec<i16> = pairs
        .iter()
        .map(|&(c, g)| (g as i32 - c as i32) as i16)
        .collect();
    end_codes.push(0xFFFF);
    start_codes.push(0xFFFF);
    id_deltas.push(1);
    let seg_count = end_codes.len() as u16;

    let mut sub = Vec::new();
    be16(4, &mut sub); // format
    let len_pos = sub.len();
    be16(0, &mut sub); // length (patched)
    be16(0, &mut sub); // language
    let seg_x2 = seg_count * 2;
    be16(seg_x2, &mut sub);
    let search_range = 2u16.pow((seg_count as f32).log2() as u32) * 2;
    be16(search_range, &mut sub);
    be16((seg_count as f32).log2() as u16, &mut sub); // entrySelector
    be16(seg_x2 - search_range, &mut sub); // rangeShift
    for &e in &end_codes {
        be16(e, &mut sub);
    }
    be16(0, &mut sub); // reservedPad
    for &s in &start_codes {
        be16(s, &mut sub);
    }
    for &d in &id_deltas {
        sub.extend_from_slice(&d.to_be_bytes());
    }
    for _ in 0..seg_count {
        be16(0, &mut sub); // idRangeOffset all 0 -> use idDelta
    }
    let sub_len = sub.len() as u16;
    sub[len_pos..len_pos + 2].copy_from_slice(&sub_len.to_be_bytes());

    // cmap header + one encoding record (3,1)
    let mut t = Vec::new();
    be16(0, &mut t); // version
    be16(1, &mut t); // numTables
    be16(3, &mut t); // platformID
    be16(1, &mut t); // encodingID
    be32(12, &mut t); // offset to subtable (4 + 8)
    t.extend_from_slice(&sub);
    t
}

fn strip_subset(name: &str) -> String {
    // "ABCDEF+Helvetica" -> "Helvetica"
    let base = name.split('+').next_back().unwrap_or(name);
    if base.is_empty() {
        "Extracted Font".to_string()
    } else {
        base.to_string()
    }
}

/// Lay out tables into an `OTTO` sfnt with the directory and checksums.
fn assemble_sfnt(mut tables: Vec<([u8; 4], Vec<u8>)>) -> Vec<u8> {
    tables.sort_by(|a, b| a.0.cmp(&b.0));
    let num = tables.len() as u16;
    let entry_selector = (15u16 - num.leading_zeros() as u16).min(15);
    let search_range = (1u16 << entry_selector) * 16;
    let range_shift = num * 16 - search_range;

    let mut out = Vec::new();
    be32(0x4F54_544F, &mut out); // 'OTTO'
    be16(num, &mut out);
    be16(search_range, &mut out);
    be16(entry_selector, &mut out);
    be16(range_shift, &mut out);

    let mut offset = 12 + num as usize * 16;
    let mut records: Vec<([u8; 4], u32, u32, u32)> = Vec::new();
    for (tag, data) in &tables {
        let checksum = table_checksum(data);
        records.push((*tag, checksum, offset as u32, data.len() as u32));
        offset += (data.len() + 3) & !3; // 4-byte aligned
    }
    for (tag, checksum, off, len) in &records {
        out.extend_from_slice(tag);
        be32(*checksum, &mut out);
        be32(*off, &mut out);
        be32(*len, &mut out);
    }
    let mut head_offset = None;
    for ((tag, data), (_, _, off, _)) in tables.iter().zip(&records) {
        if tag == b"head" {
            head_offset = Some(*off as usize);
        }
        out.extend_from_slice(data);
        while out.len() % 4 != 0 {
            out.push(0);
        }
    }

    // head.checkSumAdjustment = 0xB1B0AFBA - checksum(entire font)
    if let Some(ho) = head_offset {
        let total = table_checksum(&out);
        let adj = 0xB1B0_AFBAu32.wrapping_sub(total);
        out[ho + 8..ho + 12].copy_from_slice(&adj.to_be_bytes());
    }
    out
}

fn table_checksum(data: &[u8]) -> u32 {
    let mut sum = 0u32;
    let mut i = 0;
    while i < data.len() {
        let mut word = [0u8; 4];
        for (k, b) in word.iter_mut().enumerate() {
            if let Some(&v) = data.get(i + k) {
                *b = v;
            }
        }
        sum = sum.wrapping_add(u32::from_be_bytes(word));
        i += 4;
    }
    sum
}
