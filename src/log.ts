import {
  appendFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import type { ExtEvent } from "./events.js";

const LOG_DIR = `${homedir()}/.agent-crx`;
const LOG_FILE = `${LOG_DIR}/events.jsonl`;

export const getLogPath = (): string => LOG_FILE;

const ensureLogDir = (): void => {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
};

export const writeEvent = (event: ExtEvent): void => {
  ensureLogDir();
  appendFileSync(LOG_FILE, JSON.stringify(event) + "\n");
};

export const readEvents = (): ExtEvent[] => {
  if (!existsSync(LOG_FILE)) return [];
  const content = readFileSync(LOG_FILE, "utf-8").trim();
  if (!content) return [];
  return content.split("\n").map((line) => JSON.parse(line) as ExtEvent);
};

export const clearLog = (): void => {
  ensureLogDir();
  writeFileSync(LOG_FILE, "");
};
