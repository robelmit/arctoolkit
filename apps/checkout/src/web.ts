/**
 * The pages, built by `@arctoolkit/checkout-web` (React with shadcn/ui) into static files: two HTML templates and
 * their hashed assets. They are read once at start and served from memory. The server fills each template's data
 * slot with the JSON the page needs for its first paint; no script is ever written into a page, so the content
 * security policy allows scripts from this server only.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, relative, sep } from 'node:path';

export interface WebFile {
  readonly body: Uint8Array;
  readonly type: string;
  /** Hashed names never change, so they are cached for a year; anything else for a day. */
  readonly immutable: boolean;
}

export interface WebBundle {
  readonly pay: string;
  readonly dashboard: string;
  /** By URL path without the leading slash: `assets/pay-1a2b.js`, `favicon.svg`. */
  readonly files: ReadonlyMap<string, WebFile>;
}

/** The slot each template carries; the server replaces it whole. */
export const DATA_SLOT = '<script id="arc-data" type="application/json">{}</script>';
const TITLE = /<title>[^<]*<\/title>/;

const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

/** Where `@arctoolkit/checkout-web` put its build. */
export function defaultWebDir(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve('@arctoolkit/checkout-web/package.json')), 'dist');
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** Reads the built pages. Stops with a plain message when they are missing or not what this server expects. */
export function loadWeb(dir: string): WebBundle {
  const read = (name: string): string => {
    let html: string;
    try {
      html = readFileSync(join(dir, name), 'utf8');
    } catch {
      throw new Error(`the pages are not built: ${join(dir, name)} is missing. Run "pnpm build" first`);
    }
    if (!html.includes(DATA_SLOT) || !TITLE.test(html)) throw new Error(`${name} has no data slot or title: it was not built from @arctoolkit/checkout-web`);
    return html;
  };
  const pay = read('pay.html');
  const dashboard = read('dashboard.html');
  const files = new Map<string, WebFile>();
  for (const path of walk(dir)) {
    const name = relative(dir, path).split(sep).join('/');
    const type = TYPES[extname(name)];
    if (!type || name.endsWith('.html')) continue;
    files.set(name, { body: readFileSync(path), type, immutable: name.startsWith('assets/') });
  }
  return { pay, dashboard, files };
}

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// U+2028 and U+2029, built from their codes so no editor or tool turns them into raw line breaks here.
const LINE_SEPARATOR = new RegExp(String.fromCharCode(0x2028), 'g');
const PARAGRAPH_SEPARATOR = new RegExp(String.fromCharCode(0x2029), 'g');

/** JSON that cannot end its script element or start a comment, whatever the strings in it hold. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(LINE_SEPARATOR, '\\u2028')
    .replace(PARAGRAPH_SEPARATOR, '\\u2029');
}

/** A template with its data and title filled in. */
export function renderPage(template: string, data: unknown, title: string): string {
  return template.replace(TITLE, `<title>${escapeHtml(title)}</title>`).replace(DATA_SLOT, () => `<script id="arc-data" type="application/json">${scriptJson(data)}</script>`);
}
