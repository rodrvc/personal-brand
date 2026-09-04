import { chromium, type Browser } from "playwright";

/**
 * One warm Chromium instance for the whole process (design.md D9's "server
 * returns the active slide's PNG from its warm Chromium instance", D11's
 * "exports run in a serial queue with a warm Chromium"). Launching Chromium
 * per request would make every PNG/contrast/export call pay the ~1s launch
 * cost; this launches once, lazily, on first use, and keeps it open for the
 * server's lifetime.
 */

let browserPromise: Promise<Browser> | undefined;
let launchFailed: Error | undefined;

export async function getSharedBrowser(): Promise<Browser> {
  if (launchFailed) throw launchFailed;
  if (!browserPromise) {
    browserPromise = chromium.launch().catch((error: Error) => {
      launchFailed = error;
      browserPromise = undefined;
      throw error;
    });
  }
  return browserPromise;
}

/** Startup check: verifies Chromium can launch, without keeping a page open. Returns a human message on failure, undefined on success. */
export async function checkChromiumAvailable(): Promise<string | undefined> {
  try {
    const browser = await getSharedBrowser();
    // A cheap liveness probe beyond "launch() resolved" — opening and
    // closing a page catches a browser that launched but can't drive pages
    // (e.g. a corrupt install).
    const page = await browser.newPage();
    await page.close();
    return undefined;
  } catch (error) {
    return (
      `Playwright/Chromium is not available: ${(error as Error).message}. ` +
      "Run `npx playwright install chromium` (see docs/SETUP.md)."
    );
  }
}

export async function closeSharedBrowser(): Promise<void> {
  if (browserPromise) {
    const browser = await browserPromise.catch(() => undefined);
    await browser?.close();
    browserPromise = undefined;
  }
}
