// Parse a #rgb or #rrggbb hex string into 0-255 channels, falling back to a neutral gray.
export function parseHexColor(hex: string) {
  const value = hex.replace("#", "");
  const full = value.length === 3
    ? value.split("").map((char) => char + char).join("")
    : value;
  const int = Number.parseInt(full, 16);
  if (full.length !== 6 || Number.isNaN(int)) return { r: 74, g: 76, b: 70 };
  return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
}
