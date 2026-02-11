import { request as httpRequest } from "node:http";

export const isDaemonRunning = (daemonPort: number): Promise<boolean> =>
  new Promise((resolve) => {
    const req = httpRequest(
      { hostname: "127.0.0.1", port: daemonPort, path: "/status", method: "GET", timeout: 500 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });

export const daemonRequest = <T>(
  daemonPort: number,
  method: string,
  path: string,
  body?: unknown
): Promise<T> =>
  new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port: daemonPort,
        path,
        method,
        headers: bodyStr
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bodyStr) }
          : undefined,
        timeout: 30_000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode && res.statusCode >= 400 && parsed.error) {
              reject(new Error(parsed.error));
            } else {
              resolve(parsed as T);
            }
          } catch {
            reject(new Error(`Invalid response: ${data.slice(0, 200)}`));
          }
        });
      }
    );
    req.on("error", (err) => reject(err));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Daemon request timed out"));
    });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
