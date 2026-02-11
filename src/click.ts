const resolveSelectorExpr = (selector: string): string => {
  const escaped = JSON.stringify(selector);
  return `(() => {
  const sel = ${escaped};
  if (sel.includes('>>>')) {
    const [hostSel, innerSel] = sel.split('>>>');
    const host = document.querySelector(hostSel);
    if (!host || !host.shadowRoot) return null;
    return host.shadowRoot.querySelector(innerSel);
  }
  return document.querySelector(sel);
})()`;
};

export const buildClickExpression = (selector: string): string => `(() => {
  const resolve = () => {
    const sel = ${JSON.stringify(selector)};
    if (sel.includes('>>>')) {
      const [hostSel, innerSel] = sel.split('>>>');
      const host = document.querySelector(hostSel);
      if (!host || !host.shadowRoot) return null;
      return host.shadowRoot.querySelector(innerSel);
    }
    return document.querySelector(sel);
  };
  const el = resolve();
  if (!el) return { error: 'Element not found: ${selector.replace(/'/g, "\\'")}' };
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  el.click();
  return { ok: true, tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().slice(0, 50) };
})()`;

export const buildFillExpression = (selector: string, value: string): string => `(() => {
  const resolve = () => {
    const sel = ${JSON.stringify(selector)};
    if (sel.includes('>>>')) {
      const [hostSel, innerSel] = sel.split('>>>');
      const host = document.querySelector(hostSel);
      if (!host || !host.shadowRoot) return null;
      return host.shadowRoot.querySelector(innerSel);
    }
    return document.querySelector(sel);
  };
  const el = resolve();
  if (!el) return { error: 'Element not found: ${selector.replace(/'/g, "\\'")}' };
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  el.focus();
  const tag = el.tagName.toUpperCase();
  const setter = (tag === 'TEXTAREA'
    ? Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
    : Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  ) || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
    || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  if (setter) {
    setter.call(el, ${JSON.stringify(value)});
  } else {
    el.value = ${JSON.stringify(value)};
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, tag: el.tagName.toLowerCase(), name: el.name || undefined };
})()`;
