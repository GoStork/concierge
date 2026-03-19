function hexToHsl(hex: string): [number, number, number] {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) return [180, 40, 40];
  let r = parseInt(result[1], 16) / 255;
  let g = parseInt(result[2], 16) / 255;
  let b = parseInt(result[3], 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }
  return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
}

function hslToHex(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(100, s)) / 100;
  l = Math.max(0, Math.min(100, l)) / 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

export interface ChatPalette {
  partnerBg: string;
  partnerBorder: string;
  expertBg: string;
  expertBorder: string;
  partnerHsl: [number, number, number];
  expertHsl: [number, number, number];
}

export function deriveChatPalette(brandHex: string): ChatPalette {
  const [h, s, l] = hexToHsl(brandHex);
  const partnerHue = (h + 30) % 360;
  const expertHue = ((h - 30) + 360) % 360;
  const partnerHsl: [number, number, number] = [partnerHue, s, l];
  const expertHsl: [number, number, number] = [expertHue, s, l];
  const partnerFull = hslToHex(partnerHue, s, l);
  const expertFull = hslToHex(expertHue, s, l);
  return {
    partnerBg: `${partnerFull}14`,
    partnerBorder: `${partnerFull}33`,
    expertBg: `${expertFull}14`,
    expertBorder: `${expertFull}33`,
    partnerHsl,
    expertHsl,
  };
}

export function hslString(hsl: [number, number, number]): string {
  return `hsl(${hsl[0]}, ${hsl[1]}%, ${hsl[2]}%)`;
}
