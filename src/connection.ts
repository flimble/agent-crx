import CDP from "chrome-remote-interface";

export interface CDPTarget {
  type: string;
  url: string;
  title: string;
  id: string;
  webSocketDebuggerUrl: string;
}

export const findTargetTab = async (
  port: number,
  tabFilter?: string
): Promise<CDPTarget | null> => {
  const targets: CDPTarget[] = await CDP.List({ port });
  const pages = targets.filter((t: CDPTarget) => t.type === "page");

  if (tabFilter) {
    return pages.find((t: CDPTarget) => t.url.includes(tabFilter)) ?? null;
  }

  return pages[0] ?? null;
};

export const connectToTab = async (
  port: number,
  tabFilter?: string
): Promise<{ client: Awaited<ReturnType<typeof CDP>>; target: CDPTarget }> => {
  const target = await findTargetTab(port, tabFilter);

  if (!target) {
    throw new Error(
      tabFilter
        ? `No tab matching "${tabFilter}"`
        : "No open tabs"
    );
  }

  const client = await CDP({
    target: target.webSocketDebuggerUrl,
    port,
  });

  return { client, target };
};
