import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";

export interface ConsoleFilter {
  label: string;
  pattern: string;
}

export interface NetworkFilter {
  label: string;
  urlPattern: string;
}

export interface DomSelector {
  label: string;
  selector: string;
}

export interface ExtensionatorConfig {
  name: string;
  port: number;
  daemonPort: number;
  extensionId?: string;
  console: {
    filters: ConsoleFilter[];
    showUnmatched: boolean;
  };
  network: {
    filters: NetworkFilter[];
    showUnmatched: boolean;
  };
  dom: {
    selectors: DomSelector[];
  };
  tabFilter?: string;
}

const DEFAULT_CONFIG: ExtensionatorConfig = {
  name: "extension",
  port: 9222,
  daemonPort: 9300,
  console: {
    filters: [],
    showUnmatched: true,
  },
  network: {
    filters: [],
    showUnmatched: true,
  },
  dom: {
    selectors: [],
  },
};

const CONFIG_FILENAMES = ["agent-crx.json", "agent-crx.config.json"];

const findConfigFile = (startDir: string): string | null => {
  let dir = resolve(startDir);
  const root = resolve("/");

  while (dir !== root) {
    for (const filename of CONFIG_FILENAMES) {
      const candidate = resolve(dir, filename);
      if (existsSync(candidate)) return candidate;
    }
    dir = dirname(dir);
  }
  return null;
};

export const loadConfig = (
  cwd: string,
  overrides: Partial<ExtensionatorConfig> = {}
): ExtensionatorConfig => {
  const configPath = findConfigFile(cwd);

  if (!configPath) {
    return { ...DEFAULT_CONFIG, ...overrides };
  }

  const raw = JSON.parse(readFileSync(configPath, "utf-8"));

  return {
    name: raw.name ?? DEFAULT_CONFIG.name,
    port: overrides.port ?? raw.port ?? DEFAULT_CONFIG.port,
    daemonPort: overrides.daemonPort ?? raw.daemonPort ?? DEFAULT_CONFIG.daemonPort,
    extensionId: overrides.extensionId ?? raw.extensionId,
    console: {
      filters: raw.console?.filters ?? DEFAULT_CONFIG.console.filters,
      showUnmatched:
        raw.console?.showUnmatched ?? DEFAULT_CONFIG.console.showUnmatched,
    },
    network: {
      filters: raw.network?.filters ?? DEFAULT_CONFIG.network.filters,
      showUnmatched:
        raw.network?.showUnmatched ?? DEFAULT_CONFIG.network.showUnmatched,
    },
    dom: {
      selectors: raw.dom?.selectors ?? DEFAULT_CONFIG.dom.selectors,
    },
    tabFilter: overrides.tabFilter ?? raw.tabFilter,
  };
};
