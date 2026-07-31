// Theme control. MVP mechanism = localStorage; full per-user persistence becomes a
// Profile setting in a later story. Light is default; dark is `[data-theme="dark"]`.
export type Theme = "light" | "dark";

export function getTheme(): Theme {
  const t = document.documentElement.dataset.theme;
  return t === "dark" ? "dark" : "light";
}

export function setTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem("theme", t);
  } catch {
    /* storage unavailable — theme still applies for this session */
  }
}

export function toggleTheme(): void {
  setTheme(getTheme() === "dark" ? "light" : "dark");
}
