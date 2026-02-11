import type { DomSelector } from "./config.js";

export interface SnapshotRef {
  ref: number;
  tag: string;
  role?: string;
  text: string;
  selector: string;
  type?: string;
  name?: string;
  href?: string;
  disabled?: boolean;
}

export interface WatchlistResult {
  label: string;
  selector: string;
  found: boolean;
}

export interface SnapshotResult {
  url: string;
  title: string;
  readyState: string;
  watchlist: WatchlistResult[];
  interactiveElements: SnapshotRef[];
}

export const buildSnapshotExpression = (watchSelectors: DomSelector[]): string => {
  const watchJson = JSON.stringify(watchSelectors);
  return `(() => {
    const watchSelectors = ${watchJson};
    const watchlist = watchSelectors.map(w => ({
      label: w.label,
      selector: w.selector,
      found: document.querySelector(w.selector) !== null,
    }));

    const interactiveSelectors = [
      'button',
      'input',
      'select',
      'textarea',
      'a[href]',
      '[role="button"]',
      '[role="link"]',
      '[role="tab"]',
      '[role="menuitem"]',
      '[role="checkbox"]',
      '[role="radio"]',
      '[role="switch"]',
      '[contenteditable="true"]',
      '[onclick]',
      '[tabindex]:not([tabindex="-1"])',
    ];

    // Collect all interactive elements, including inside shadow DOMs
    const allCandidates = [];
    const seen = new Set();

    const collectFrom = (root, shadowHost) => {
      for (const sel of interactiveSelectors) {
        for (const el of root.querySelectorAll(sel)) {
          if (seen.has(el)) continue;
          // Visibility check: for shadow DOM elements, check computed style
          if (shadowHost) {
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
          } else {
            if (el.offsetParent === null && el.tagName !== 'BODY' && el.tagName !== 'HTML') continue;
          }
          seen.add(el);
          allCandidates.push({ el, shadowHost });
        }
      }
    };

    // Main document
    collectFrom(document, null);

    // Shadow DOMs
    const shadowHosts = document.querySelectorAll('*');
    for (const host of shadowHosts) {
      if (host.shadowRoot) {
        collectFrom(host.shadowRoot, host);
      }
    }

    // Sort by document position (shadow elements come after their host)
    allCandidates.sort((a, b) => {
      const elA = a.shadowHost || a.el;
      const elB = b.shadowHost || b.el;
      if (elA === elB) {
        // Both in same shadow host, compare inner elements
        if (a.shadowHost && b.shadowHost) {
          const pos = a.el.compareDocumentPosition(b.el);
          if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
          if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
          return 0;
        }
        return a.shadowHost ? 1 : -1;
      }
      const pos = elA.compareDocumentPosition(elB);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });

    // Split into main doc and shadow DOM candidates
    const mainCandidates = allCandidates.filter(c => !c.shadowHost);
    const shadowCandidates = allCandidates.filter(c => c.shadowHost);

    // Reserve up to 25 slots for shadow DOM elements if they exist
    const mainLimit = shadowCandidates.length > 0 ? 50 : 75;
    const shadowLimit = 25;

    const finalCandidates = [
      ...mainCandidates.slice(0, mainLimit),
      ...shadowCandidates.slice(0, shadowLimit),
    ];

    const elements = [];
    let ref = 1;

    for (const candidate of finalCandidates) {
        const el = candidate.el;
        const shadowHost = candidate.shadowHost;

        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute('role') || undefined;
        const text = (el.textContent || '').trim().slice(0, 60);
        const type = el.getAttribute('type') || undefined;
        const name = el.getAttribute('name') || undefined;
        const href = el.getAttribute('href') || undefined;
        const disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true' || undefined;

        // Determine the query root (shadow root or document)
        const queryRoot = shadowHost ? shadowHost.shadowRoot : document;

        let innerSelector = '';
        const id = el.getAttribute('id');
        const testId = el.getAttribute('data-testid');
        const ariaLabel = el.getAttribute('aria-label');
        if (id) {
          innerSelector = '#' + CSS.escape(id);
        } else if (testId) {
          innerSelector = '[data-testid="' + testId + '"]';
        } else if (ariaLabel) {
          innerSelector = '[aria-label="' + ariaLabel.replace(/"/g, '\\\\"') + '"]';
        } else if (name && tag === 'input') {
          innerSelector = tag + '[name="' + name + '"]';
        } else {
          // Build a unique CSS path by walking up the DOM tree
          const buildPath = (node, root) => {
            const parts = [];
            let cur = node;
            let foundId = false;
            const stopAt = root === document ? document.body : null;
            while (cur && cur !== document.body && cur !== document.documentElement && cur !== root) {
              const curTag = cur.tagName.toLowerCase();
              const curId = cur.getAttribute('id');
              if (curId) {
                parts.unshift('#' + CSS.escape(curId));
                foundId = true;
                break;
              }
              const parent = cur.parentElement;
              if (!parent) { parts.unshift(curTag); break; }
              const siblings = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
              if (siblings.length === 1) {
                parts.unshift(curTag);
              } else {
                const idx = siblings.indexOf(cur) + 1;
                parts.unshift(curTag + ':nth-of-type(' + idx + ')');
              }
              cur = parent;
            }
            const path = parts.join(' > ');
            if (!foundId && !shadowHost) return 'body > ' + path;
            return path;
          };
          innerSelector = buildPath(el, queryRoot);
          // Verify uniqueness within the query root
          try {
            if (queryRoot.querySelectorAll(innerSelector).length !== 1) {
              const allEls = Array.from(queryRoot.querySelectorAll(tag));
              const globalIdx = allEls.indexOf(el);
              if (globalIdx >= 0) {
                innerSelector = tag + ':nth-of-type(' + (globalIdx + 1) + ')';
              }
            }
          } catch(e) {
            const allEls = Array.from(queryRoot.querySelectorAll(tag));
            const globalIdx = allEls.indexOf(el);
            if (globalIdx >= 0) {
              innerSelector = tag + ':nth-of-type(' + (globalIdx + 1) + ')';
            }
          }
        }

        // For shadow DOM elements, prefix with host selector >>> inner selector
        let selector = innerSelector;
        if (shadowHost) {
          const hostTag = shadowHost.tagName.toLowerCase();
          const hostId = shadowHost.getAttribute('id');
          const hostTestId = shadowHost.getAttribute('data-testid');
          const hostSelector = hostId ? '#' + CSS.escape(hostId)
            : hostTestId ? '[data-testid="' + hostTestId + '"]'
            : hostTag;
          selector = hostSelector + '>>>' + innerSelector;
        }

        elements.push({ ref: ref++, tag, role, text, selector, type, name, href, disabled });

        if (ref > 75) break;
    }

    return {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      watchlist,
      interactiveElements: elements,
    };
  })()`;
};

export const formatSnapshot = (
  result: SnapshotResult,
  extInfo?: { name: string; version: string; errorCount: number }
): string => {
  const lines: string[] = [];
  lines.push(`URL: ${result.url}`);
  lines.push(`Title: ${result.title}`);

  if (extInfo) {
    const errors = extInfo.errorCount > 0 ? `, ${extInfo.errorCount} error${extInfo.errorCount > 1 ? "s" : ""}` : "";
    lines.push(`Extension: ${extInfo.name} v${extInfo.version} (loaded${errors})`);
  }

  if (result.watchlist.length > 0) {
    lines.push("");
    lines.push("DOM watchlist:");
    for (const w of result.watchlist) {
      const status = w.found ? "OK" : "MISSING";
      lines.push(`  [${status}] ${w.label}: ${w.selector}`);
    }
  }

  if (result.interactiveElements.length > 0) {
    lines.push("");
    lines.push(`Interactive elements (${result.interactiveElements.length}):`);
    for (const el of result.interactiveElements) {
      const desc = formatElementRef(el);
      lines.push(`  @${el.ref} ${desc}`);
    }
  }

  return lines.join("\n");
};

const formatElementRef = (el: SnapshotRef): string => {
  const parts: string[] = [el.tag];
  if (el.role) parts[0] = el.role;
  if (el.type && el.tag === "input") parts.push(`[${el.type}]`);
  if (el.disabled) parts.push("(disabled)");
  if (el.text) parts.push(`"${el.text}"`);
  else if (el.href) parts.push(el.href.length > 60 ? el.href.slice(0, 57) + "..." : el.href);
  return parts.join(" ");
};
