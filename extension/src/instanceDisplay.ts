// MODCDP_TS_ONLY: DO NOT TRANSLATE THIS FILE TO OTHER LANGUAGES.
// Reason: only runs in browser.

export function instanceDisplayNumber(value: { display_number?: unknown }): number | null {
  const number = value.display_number;
  return typeof number === "number" && Number.isSafeInteger(number) && number > 0 ? number : null;
}

export function instanceLabel(value: { name?: unknown; display_number?: unknown }): string {
  const number = instanceDisplayNumber(value);
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (number === null) return `${name || "浏览器"} · 暂无编号`;
  const fallback = `浏览器 ${number}`;
  return name && name !== fallback ? `${name} · 编号 ${number}` : fallback;
}
