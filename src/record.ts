import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { connectToTab } from "./connection.js";

interface RecordOptions {
  port: number;
  tabFilter?: string;
  output?: string;
  duration: number;
  fps: number;
  maxWidth: number;
}

const checkFfmpeg = (): void => {
  try {
    execSync("ffmpeg -version", { stdio: "ignore" });
  } catch {
    console.error("ffmpeg is required for recording. Install it:");
    console.error("  brew install ffmpeg");
    process.exit(1);
  }
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const record = async (opts: RecordOptions): Promise<string> => {
  checkFfmpeg();

  const { client, target } = await connectToTab(opts.port, opts.tabFilter);
  const tempDir = join(tmpdir(), `agent-crx-record-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });

  const outputPath = resolve(
    opts.output ?? `recording-${Date.now()}.gif`
  );

  const intervalMs = Math.round(1000 / opts.fps);
  const totalFrames = opts.duration * opts.fps;

  console.log(`Recording: ${target.url}`);
  console.log(`Duration: ${opts.duration}s, FPS: ${opts.fps}, Max width: ${opts.maxWidth}px`);
  console.log("Press Ctrl+C to stop early...");

  let frameCount = 0;
  let stopped = false;

  const onSignal = () => { stopped = true; };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    await client.Page.enable();
    await client.Page.bringToFront();

    // Capture frames at fixed intervals using Page.captureScreenshot
    while (frameCount < totalFrames && !stopped) {
      const start = Date.now();
      try {
        const { data } = await client.Page.captureScreenshot({
          format: "jpeg",
          quality: 80,
          clip: undefined,
        });
        const framePath = join(tempDir, `frame-${String(frameCount).padStart(6, "0")}.jpg`);
        writeFileSync(framePath, Buffer.from(data, "base64"));
        frameCount++;
      } catch {
        // Skip frame on capture error (tab navigating, etc.)
      }

      const elapsed = Date.now() - start;
      const remaining = intervalMs - elapsed;
      if (remaining > 0) await sleep(remaining);
    }

    console.log(`Captured ${frameCount} frames`);

    if (frameCount === 0) {
      console.error("No frames captured.");
      process.exit(1);
    }

    // Resize + create GIF via ffmpeg
    console.log("Encoding GIF...");
    const palette = join(tempDir, "palette.png");

    // Generate optimal palette with resize
    execSync(
      `ffmpeg -y -framerate ${opts.fps} -i "${join(tempDir, "frame-%06d.jpg")}" -vf "scale='min(${opts.maxWidth},iw)':-1:flags=lanczos,palettegen=stats_mode=diff" "${palette}"`,
      { stdio: "ignore" }
    );

    // Create GIF with palette
    execSync(
      `ffmpeg -y -framerate ${opts.fps} -i "${join(tempDir, "frame-%06d.jpg")}" -i "${palette}" -lavfi "scale='min(${opts.maxWidth},iw)':-1:flags=lanczos [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" "${outputPath}"`,
      { stdio: "ignore" }
    );

    console.log(outputPath);
    return outputPath;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await client.close();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
  }
};
