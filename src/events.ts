export interface ConsoleEvent {
  type: "console";
  ts: string;
  session: string;
  level: "log" | "info" | "warn" | "error" | "debug";
  label: string | null;
  text: string;
}

export interface NetworkRequestEvent {
  type: "request";
  ts: string;
  session: string;
  label: string | null;
  method: string;
  url: string;
}

export interface NetworkResponseEvent {
  type: "response";
  ts: string;
  session: string;
  label: string | null;
  status: number;
  url: string;
}

export interface NetworkErrorEvent {
  type: "network_error";
  ts: string;
  session: string;
  label: string | null;
  error: string;
  resourceType: string;
  url: string;
}

export interface ExceptionEvent {
  type: "exception";
  ts: string;
  session: string;
  label: null;
  text: string;
}

export interface ScreenshotEvent {
  type: "screenshot";
  ts: string;
  session: string;
  label: null;
  path: string;
}

export type ExtEvent =
  | ConsoleEvent
  | NetworkRequestEvent
  | NetworkResponseEvent
  | NetworkErrorEvent
  | ExceptionEvent
  | ScreenshotEvent;

export type ExtEventWithoutSession =
  | Omit<ConsoleEvent, "session">
  | Omit<NetworkRequestEvent, "session">
  | Omit<NetworkResponseEvent, "session">
  | Omit<NetworkErrorEvent, "session">
  | Omit<ExceptionEvent, "session">
  | Omit<ScreenshotEvent, "session">;

export const now = (): string => new Date().toISOString();

export const generateSessionId = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
