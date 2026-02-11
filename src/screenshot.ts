import { writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { connectToTab } from "./connection.js";

const SCREENSHOTS_DIR = join(homedir(), ".agent-crx", "screenshots");
const MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

const ensureDir = (): void => {
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });
};

const cleanOld = (): void => {
  try {
    const cutoff = Date.now() - MAX_AGE_MS;
    for (const name of readdirSync(SCREENSHOTS_DIR)) {
      const path = join(SCREENSHOTS_DIR, name);
      try {
        if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
      } catch {
        // skip files we can't stat/delete
      }
    }
  } catch {
    // dir may not exist yet
  }
};

interface ScreenshotOptions {
  port: number;
  tabFilter?: string;
  selector?: string;
  output?: string;
}

export const takeScreenshot = async (
  options: ScreenshotOptions
): Promise<string> => {
  const { client } = await connectToTab(options.port, options.tabFilter);

  try {
    const { Page, Runtime, DOM } = client;
    await Page.enable();

    let screenshotParams: Record<string, unknown> = { format: "png" };

    if (options.selector) {
      await DOM.enable();
      await Runtime.enable();

      const result = await Runtime.evaluate({
        expression: `(() => {
          const el = document.querySelector(${JSON.stringify(options.selector)});
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        })()`,
        returnByValue: true,
      });

      const bounds = result.result?.value as Record<string, number> | null;
      if (bounds) {
        screenshotParams = {
          format: "png",
          clip: {
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
            scale: 1,
          },
        };
      }
    }

    const { data } = await Page.captureScreenshot(screenshotParams);

    if (options.output) {
      const filepath = resolve(options.output);
      mkdirSync(dirname(filepath), { recursive: true });
      writeFileSync(filepath, Buffer.from(data, "base64"));
      return filepath;
    }

    ensureDir();
    cleanOld();

    const filename = `shot-${Date.now()}.png`;
    const filepath = join(SCREENSHOTS_DIR, filename);
    writeFileSync(filepath, Buffer.from(data, "base64"));

    return filepath;
  } finally {
    await client.close();
  }
};
