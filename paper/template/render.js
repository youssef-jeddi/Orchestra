// Render paper.html → paper.pdf using the locally installed Brave via
// puppeteer-core, waiting for paged.js to finish pagination before printing.
// Called by build.sh (which serves the paper/ directory over localhost first).
const puppeteer = require("puppeteer-core");

const BROWSER =
  process.env.BROWSER_BIN ||
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
const URL = process.argv[2];
const OUT = process.argv[3] || "paper.pdf";

(async () => {
  const browser = await puppeteer.launch({
    executablePath: BROWSER,
    headless: true,
    args: ["--disable-gpu", "--no-first-run"],
  });
  try {
    const page = await browser.newPage();
    // paged.js honors window.PagedConfig.after — flag completion for waitForFunction.
    await page.evaluateOnNewDocument(() => {
      window.PagedConfig = { auto: true, after: () => (window.__pagedDone = true) };
    });
    page.on("pageerror", (e) => console.error("page error:", e.message));
    await page.goto(URL, { waitUntil: "networkidle0", timeout: 60000 });
    await page.waitForFunction(() => window.__pagedDone === true, { timeout: 90000 });
    await page.pdf({
      path: OUT,
      preferCSSPageSize: true,
      printBackground: true,
      displayHeaderFooter: false,
    });
    const pages = await page.evaluate(
      () => document.querySelectorAll(".pagedjs_page").length
    );
    console.log(`rendered ${pages} pages → ${OUT}`);
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
