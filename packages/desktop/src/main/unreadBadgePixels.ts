const DOT_COLOR = { red: 229, green: 57, blue: 53 };
const SUPERSAMPLE = 4;

export function renderTaskbarStatusDotPixels(
  scale: 1 | 2 = 1,
  layout: "windows-10" | "windows-11" = "windows-11",
): Uint8Array {
  const center = (layout === "windows-10" ? 11.25 : 8) * scale;
  return renderDot(16 * scale, center, center, 3.5 * scale);
}

export function renderTrayStatusDotPixels(size: number): Uint8Array {
  return renderDot(size, size / 2, size / 2, Math.max(1, size / 2 - 1));
}

function renderDot(size: number, centerX: number, centerY: number, radius: number): Uint8Array {
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let covered = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const dx = x + (sx + 0.5) / SUPERSAMPLE - centerX;
          const dy = y + (sy + 0.5) / SUPERSAMPLE - centerY;
          if (dx * dx + dy * dy <= radius * radius) covered += 1;
        }
      }
      const coverage = covered / (SUPERSAMPLE * SUPERSAMPLE);
      const offset = (y * size + x) * 4;
      // Electron bitmap 使用预乘 BGRA，边缘也必须预乘以免与底图混出白边。
      pixels[offset] = Math.round(DOT_COLOR.blue * coverage);
      pixels[offset + 1] = Math.round(DOT_COLOR.green * coverage);
      pixels[offset + 2] = Math.round(DOT_COLOR.red * coverage);
      pixels[offset + 3] = Math.round(255 * coverage);
    }
  }
  return pixels;
}

export function blendBadgeIntoBitmap(options: {
  base: Uint8Array;
  size: number;
  badge: Uint8Array;
  badgeSize: number;
  originX: number;
  originY: number;
}): void {
  for (let by = 0; by < options.badgeSize; by += 1) {
    for (let bx = 0; bx < options.badgeSize; bx += 1) {
      const x = options.originX + bx;
      const y = options.originY + by;
      if (x < 0 || y < 0 || x >= options.size || y >= options.size) continue;
      const source = (by * options.badgeSize + bx) * 4;
      const destination = (y * options.size + x) * 4;
      const keep = 1 - options.badge[source + 3]! / 255;
      for (let channel = 0; channel < 4; channel += 1)
        options.base[destination + channel] = Math.round(
          options.badge[source + channel]! + options.base[destination + channel]! * keep,
        );
    }
  }
}
