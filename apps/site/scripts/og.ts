// Builds the link-preview (OG) images: Midjourney skies in og/, the light app
// icon, and a Geist wordmark composed by og/serif.html or og/pixel.html. All
// four candidates and a side-by-side sheet land in og/out/ (not committed);
// the one the site uses is copied to public/og.jpg.
//
// Needs macOS with Xcode (ictool exports the icon), ImageMagick (`magick`) and
// Playwright's Chromium. Rebuilds are byte-identical: the grain is seeded.
//
// Usage: bun scripts/og.ts

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

type Variant = {
  plate: string;
  /** Percent past cover; B1 zooms so its lower-right cloud clears the wordmark. */
  zoom: number;
  anchor: string;
  style: "serif" | "pixel";
  /** Wordmark hex without #, for a wordmark that sits on cloud. */
  color?: string;
};

const variants: Record<string, Variant> = {
  "1-b1-serif": { plate: "bg-b1.png", zoom: 115, anchor: "northwest", style: "serif" },
  "2-b1-pixel": { plate: "bg-b1.png", zoom: 115, anchor: "northwest", style: "pixel" },
  "3-a3-serif": { plate: "bg-a3.png", zoom: 100, anchor: "center", style: "serif", color: "0d2b4f" },
  "4-a3-pixel": { plate: "bg-a3.png", zoom: 100, anchor: "center", style: "pixel", color: "0d2b4f" },
};
const siteImage = "1-b1-serif";

const site = fileURLToPath(new URL("..", import.meta.url));
const og = join(site, "og");
const out = join(og, "out");
const ictool = "/Applications/Xcode.app/Contents/Applications/Icon Composer.app/Contents/Executables/ictool";

const magick = (...args: string[]) => execFileSync("magick", args, { cwd: out, stdio: "inherit" });
const cover = ["-filter", "Lanczos", "-resize", "2400x1260^", "-gravity", "center", "-extent", "2400x1260"];

mkdirSync(out, { recursive: true });
execFileSync(ictool, [
  join(site, "../desktop/build/icon.icon"),
  ...["--export-image", "--output-file", join(out, "logo.png"), "--platform", "macOS", "--rendition", "Default"],
  ...["--width", "512", "--height", "512", "--scale", "2"],
]);
magick("-size", "1200x630", "xc:gray50", "-seed", "7", "-attenuate", "0.6", "+noise", "Gaussian", "-colorspace", "gray", "grain.png");

// pixel.html reads the plate back from a canvas, which file:// would taint.
const browser = await chromium.launch({ args: ["--allow-file-access-from-files"] });

async function render(page: string, file: string, width: number, height: number, scale: number) {
  const tab = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
  await tab.goto(`file://${join(og, page)}`);
  await tab.evaluate(() => document.fonts.ready);
  await tab.waitForFunction(() => !document.querySelector("canvas") || document.body.dataset.ready);
  await tab.screenshot({ path: join(out, file) });
  await tab.close();
}

for (const [name, v] of Object.entries(variants)) {
  // Cover the 2x canvas, then zoom past it and crop from the anchor.
  magick(join(og, v.plate), ...cover, "-resize", `${v.zoom}%`, "-gravity", v.anchor, "-extent", "2400x1260", "plate.png");
  const query = v.color ? `?color=${v.color}` : "";
  if (v.style === "pixel") {
    // A five-color dither stays small as PNG; JPEG would smear it.
    await render(`pixel.html${query}`, `${name}.png`, 1200, 630, 1);
    continue;
  }
  // Clouds drift: half the plate is a horizontal motion blur of itself.
  magick("plate.png", "(", "+clone", "-motion-blur", "0x60+180", ")", "-compose", "blend", "-define", "compose:args=50", "-composite", "plate.png");
  await render(`serif.html${query}`, "raw.png", 1200, 630, 2);
  // Grain goes on after the downscale, or resampling smooths it away.
  magick("raw.png", "-filter", "Lanczos", "-resize", "1200x630", "1x.png");
  magick("1x.png", "grain.png", "-compose", "softlight", "-composite", "-quality", "88", "-sampling-factor", "4:4:4", "-strip", `${name}.jpg`);
}

await render("compare.html", "compare.png", 2160, 1300, 1);
await browser.close();
copyFileSync(join(out, `${siteImage}.jpg`), join(site, "public/og.jpg"));
