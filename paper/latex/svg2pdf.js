// Convert the paper figures (SVG) to exact-size vector PDFs for LaTeX.
// Usage: node svg2pdf.js   (from paper/latex/; writes figs/*.pdf)
const puppeteer = require("puppeteer-core");
const fs = require("fs");
const path = require("path");

const BROWSER =
  process.env.BROWSER_BIN ||
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";

const FIGS = [
  { src: "../figures/fig2-architecture.svg", out: "figs/fig2-architecture.pdf", w: 900, h: 460 },
  { src: "../figures/fig3-decide-flowchart.svg", out: "figs/fig3-decide-flowchart.pdf", w: 860, h: 580 },
  { src: "../figures/fig4-approval-ladder.svg", out: "figs/fig4-approval-ladder.pdf", w: 900, h: 300 },
];

(async () => {
  fs.mkdirSync("figs", { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: BROWSER,
    headless: true,
    args: ["--disable-gpu", "--no-first-run"],
  });
  try {
    for (const f of FIGS) {
      const svg = fs.readFileSync(path.resolve(f.src), "utf-8");
      const html = `<!DOCTYPE html><html><head><style>
        @page { size: ${f.w}px ${f.h}px; margin: 0; }
        body { margin: 0; }
        svg { display: block; width: ${f.w}px; height: ${f.h}px; }
      </style></head><body>${svg}</body></html>`;
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: "load" });
      await page.pdf({
        path: f.out,
        width: `${f.w}px`,
        height: `${f.h}px`,
        margin: { top: 0, right: 0, bottom: 0, left: 0 },
        printBackground: true,
        preferCSSPageSize: true,
      });
      await page.close();
      console.log(`✓ ${f.out}`);
    }
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
