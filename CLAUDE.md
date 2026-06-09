# tools.enigmeta.com

A collection of small, personally-useful tools for [enigmeta.com](https://enigmeta.com),
Frederik's personal website.

## Guiding principles

1. **Privacy-respecting by architecture.** Tools must process the user's data
   _in the browser_. No uploads, no servers doing the work, no telemetry. The
   site is static; there is no backend to send data to. This is a structural
   guarantee, not a policy promise.
2. **Runs in the browser.** Logic is implemented in JavaScript/TypeScript or, for
   heavier lifting, in **Rust compiled to WebAssembly**. Prefer Rust/WASM when a
   task benefits from real parsing, decoding, or compute (e.g. the PDF extractor).
   Keep JS for the DOM, file handling, and packaging.
3. **Minimal, maintained, personal.** Each tool earns its place by being something
   Frederik actually uses. Small surface area, easy to keep alive over years.

## Design system

Minimal, typographic, near-monochrome. Follows the FDB style conventions.

- **OKLCH** for every color, with hue/chroma as CSS variables so shades come from
  varying lightness only. Defined in `src/styles/tokens.css`.
- **No rounded corners** anywhere (`border-radius: 0`).
- Black/white palette with gray shades; a single restrained accent hue.
- **Typographic grid**: a fluid type scale (`--step-*`) and spacing scale, a
  constrained measure for text, and a responsive content grid. Works mobile-first.
- Light/dark via `prefers-color-scheme`, overridable with `data-theme` on `<html>`.
- Transitions: `0.15s ease` for hover/focus states.

## Architecture

Static multi-page site built with **Vite**. The site is served at
`tools.enigmeta.com`, so each tool lives at the root path `/<name>/` — its source
is a top-level `<name>/` folder (the Vite MPA output mirrors source location).
Shared styles live in `src/styles/`. Rust crates live in `crates/` and compile to
WASM via `wasm-pack` (`--target web`), output to `src/wasm/<crate>/` and imported
directly by the tool's TypeScript.

```
index.html                 Landing page (lists tools)
src/styles/tokens.css      OKLCH design tokens
src/styles/base.css        Reset + typographic grid + layout
src/styles/site.css        Shared app chrome (header, cards, dropzone, gallery)
src/theme.ts               Light/dark toggle
<name>/index.html          Tool entry (Vite MPA input) -> served at /<name>/
<name>/main.ts             Tool logic
crates/<name>/             Rust crate -> WASM
src/wasm/<name>/           wasm-pack output (gitignored)
```

## Commands

```bash
npm run dev         # wasm build + vite dev server
npm run build       # wasm build + vite production build -> dist/
npm run preview     # preview the production build
npm run wasm        # build all Rust crates to WASM only
npm run typecheck   # tsc --noEmit
```

## Adding a tool

1. Create `<name>/index.html` + `main.ts` at the repo root.
2. Register the HTML file as a Vite input in `vite.config.ts`.
3. Add a card to the landing page in `index.html`.
4. If it needs Rust, add a crate under `crates/<name>/` and a `wasm-pack` step to
   the `wasm` npm script.

## Deployment

Deployed to **GitHub Pages** via `.github/workflows/deploy.yml` on every push to
`main`: the workflow installs Rust + wasm-pack + Node, runs `npm run build`, and
publishes `dist/`. Served at the custom domain **tools.enigmeta.com** (`public/CNAME`),
so the Vite `base` is `/`. The `.wasm` files are served as static assets (GitHub
Pages sends the correct `application/wasm` MIME type).

Custom domain DNS: a `CNAME` record `tools` → `fdb.github.io`.
