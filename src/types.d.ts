declare module "chrome-remote-interface" {
  interface Target {
    description: string;
    devtoolsFrontendUrl: string;
    id: string;
    title: string;
    type: string;
    url: string;
    webSocketDebuggerUrl: string;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type CDPHandler = (params: any) => void;

  interface CDPClient {
    Page: {
      enable(): Promise<void>;
      captureScreenshot(params?: Record<string, unknown>): Promise<{ data: string }>;
      navigate(params: { url: string }): Promise<{ frameId: string }>;
      reload(params?: { ignoreCache?: boolean }): Promise<void>;
      startScreencast(params: {
        format: string;
        quality?: number;
        maxWidth?: number;
        maxHeight?: number;
        everyNthFrame?: number;
      }): Promise<void>;
      stopScreencast(): Promise<void>;
      screencastFrame(handler: CDPHandler): void;
      screencastFrameAck(params: { sessionId: number }): Promise<void>;
      close(): Promise<void>;
      bringToFront(): Promise<void>;
    };
    Runtime: {
      enable(): Promise<void>;
      evaluate(params: {
        expression: string;
        returnByValue?: boolean;
        awaitPromise?: boolean;
      }): Promise<{
        result?: { value?: unknown };
        exceptionDetails?: { text: string; exception?: { description?: string } };
      }>;
      consoleAPICalled(handler: CDPHandler): void;
      exceptionThrown(handler: CDPHandler): void;
    };
    Network: {
      enable(params: Record<string, unknown>): Promise<void>;
      requestWillBeSent(handler: CDPHandler): void;
      responseReceived(handler: CDPHandler): void;
      loadingFailed(handler: CDPHandler): void;
    };
    DOM: {
      enable(): Promise<void>;
    };
    Target: {
      createTarget(params: { url: string }): Promise<{ targetId: string }>;
      closeTarget(params: { targetId: string }): Promise<{ success: boolean }>;
    };
    close(): Promise<void>;
    on(event: string, handler: (...args: unknown[]) => void): void;
    off(event: string, handler: (...args: unknown[]) => void): void;
  }

  interface CDPOptions {
    target?: string;
    port?: number;
  }

  interface ListOptions {
    port: number;
  }

  function CDP(options?: CDPOptions): Promise<CDPClient>;

  namespace CDP {
    function List(options: ListOptions): Promise<Target[]>;
    type Target = import("chrome-remote-interface").Target;
  }

  export = CDP;
}
