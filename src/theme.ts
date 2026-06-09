// Tiny theme toggle: cycles light/dark, persisted, defaults to system preference.

const KEY = "enigmeta-theme";
type Theme = "light" | "dark";

function stored(): Theme | null {
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "dark" ? v : null;
}

function systemDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function apply(theme: Theme | null) {
  const root = document.documentElement;
  if (theme) root.setAttribute("data-theme", theme);
  else root.removeAttribute("data-theme");
}

export function initTheme() {
  apply(stored());
  const btn = document.querySelector<HTMLButtonElement>("[data-theme-toggle]");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const current = stored() ?? (systemDark() ? "dark" : "light");
    const next: Theme = current === "dark" ? "light" : "dark";
    localStorage.setItem(KEY, next);
    apply(next);
  });
}
