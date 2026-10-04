/**
 * Tiny DOM helpers. This project uses no UI framework, so these cover the
 * handful of things that would otherwise be repetitive.
 */

type Attributes = Record<string, string | number | boolean | undefined | EventListener>;
type Child = Node | string | number | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Attributes = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === 'class') {
      node.className = String(value);
    } else if (key === 'html') {
      node.innerHTML = String(value);
    } else if (key === 'value' && node instanceof HTMLInputElement) {
      node.value = String(value);
    } else if (key === 'checked' && node instanceof HTMLInputElement) {
      node.checked = Boolean(value);
    } else {
      node.setAttribute(key, String(value));
    }
  }

  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node: Element): void {
  node.replaceChildren();
}

export function qs<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T {
  const node = root.querySelector<T>(selector);
  if (!node) throw new Error(`Missing required element: ${selector}`);
  return node;
}

/** Formats a count with thin separators, e.g. 12,885. */
export function num(value: number): string {
  return value.toLocaleString('en-US');
}

export function pct(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

/** "February_10" -> "10 Feb". */
export function prettyDay(day: string): string {
  const match = /month_(\d+)_(\d+)/i.exec(day);
  if (!match) return day;
  const month = Number(match[1]);
  const date = Number(match[2]);
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${date} ${names[month - 1] ?? month}`;
}

/** Shortens a uuid for display: "1298e3e2...b041561". */
export function shortId(id: string, head = 8, tail = 4): string {
  if (id.length <= head + tail + 1) return id;
  return `${id.slice(0, head)}...${id.slice(-tail)}`;
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}