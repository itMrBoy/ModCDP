const colors = ["#2563eb", "#7c3aed", "#0f766e", "#be123c", "#b45309", "#4338ca"];

export function instanceAppearance(number) {
  const valid = Number.isSafeInteger(number) && number > 0;
  return {
    background: valid ? colors[(number - 1) % colors.length] : "#64748b",
    foreground: "#ffffff",
  };
}
