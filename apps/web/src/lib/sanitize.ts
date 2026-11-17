/**
 * The one place feed HTML is sanitised (spec 10.5). `content_html` is stored raw; this runs in the
 * browser and its output is the only thing `ArticleContent` ever injects. Allowlist of tags and
 * attributes, no `style`, `class`, `id` or `on*`, only http(s) and mailto URLs (relative ones are
 * resolved against the entry URL first), every link opens in a new tab, every image is lazy and
 * sends no referrer, and an iframe becomes a link ("Open embedded content").
 */
import DOMPurify from 'dompurify';

const ALLOWED_TAGS = [
  ...'p br a strong em b i u s blockquote q cite code pre kbd ul ol li dl dt dd h1 h2 h3 h4 h5 h6 hr img picture source figure figcaption table thead tbody tfoot tr th td caption sup sub small abbr time mark del ins details summary video audio'.split(
    ' ',
  ),
];

// No `style`, `class`, `id`, `srcset` (its candidate URLs would each need resolving) or `on*`.
const ALLOWED_ATTR = [
  'href',
  'src',
  'poster',
  'alt',
  'title',
  'width',
  'height',
  'controls',
  'preload',
  'type',
  'cite',
  'datetime',
  'colspan',
  'rowspan',
  'scope',
  'open',
  // Set by the hook below, kept so DOMPurify does not strip them again.
  'target',
  'rel',
  'loading',
  'decoding',
  'referrerpolicy',
];

const FORBID_TAGS = ['style', 'iframe', 'form', 'input', 'svg', 'math', 'object', 'embed'];
const URL_ATTRS = ['href', 'src', 'poster'];
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

export const EMBED_LINK_TEXT = 'Open embedded content';

function parseBase(url: string | null): URL | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

/** Absolute http(s) or mailto URL, or null when the value is relative with no base or not allowed. */
function resolveUrl(value: string, base: URL | null): string | null {
  try {
    const u = base ? new URL(value.trim(), base) : new URL(value.trim());
    return SAFE_PROTOCOLS.has(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

let hooked = false;

function installHooks(): void {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (!(node instanceof Element)) return;
    const tag = node.tagName.toLowerCase();
    if (tag === 'a') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer nofollow');
    } else if (tag === 'img') {
      node.setAttribute('loading', 'lazy');
      node.setAttribute('decoding', 'async');
      node.setAttribute('referrerpolicy', 'no-referrer');
    } else if (tag === 'video' || tag === 'audio') {
      node.setAttribute('controls', '');
      node.setAttribute('preload', 'none');
    } else {
      // Only links, images and media may carry these.
      for (const a of ['target', 'rel', 'loading', 'decoding', 'referrerpolicy']) {
        node.removeAttribute(a);
      }
    }
  });
}

/**
 * Makes every URL absolute against the entry URL, and drops any that is not http(s) or mailto.
 * This runs before DOMPurify, whose own URL check would otherwise remove relative links.
 */
function resolveUrls(root: ParentNode, baseUrl: URL | null): void {
  for (const attr of URL_ATTRS) {
    for (const el of Array.from(root.querySelectorAll(`[${attr}]`))) {
      const resolved = resolveUrl(el.getAttribute(attr) ?? '', baseUrl);
      if (resolved === null) el.removeAttribute(attr);
      else el.setAttribute(attr, resolved);
    }
  }
}

/** Swaps every iframe for a link to its address, or drops it when it has no usable address. */
function replaceIframes(root: ParentNode, baseUrl: URL | null): void {
  for (const frame of Array.from(root.querySelectorAll('iframe'))) {
    const src = frame.getAttribute('src');
    const href = src === null ? null : resolveUrl(src, baseUrl);
    if (href === null || href.startsWith('mailto:')) {
      frame.remove();
      continue;
    }
    const p = frame.ownerDocument.createElement('p');
    const a = frame.ownerDocument.createElement('a');
    a.setAttribute('href', href);
    a.textContent = EMBED_LINK_TEXT;
    p.append(a);
    frame.replaceWith(p);
  }
}

/** Returns HTML that is safe to insert. `entryUrl` resolves relative links and images. */
export function sanitizeArticleHtml(html: string, entryUrl: string | null): string {
  installHooks();
  const base = parseBase(entryUrl);
  // Parsed in an inert document (no scripts run, no images load), then handed to DOMPurify as a
  // node so the markup is not serialised and parsed a second time.
  const doc = new DOMParser().parseFromString(html, 'text/html');
  replaceIframes(doc.body, base);
  resolveUrls(doc.body, base);
  // A wrapper, because DOMPurify would try to remove <body> itself (it is not on the allowlist).
  const box = doc.createElement('div');
  box.append(...Array.from(doc.body.childNodes));
  return DOMPurify.sanitize(box, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    FORBID_TAGS,
    FORBID_ATTR: ['style', 'class', 'id', 'srcdoc'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ALLOWED_URI_REGEXP: /^(?:https?|mailto):/i,
    RETURN_TRUSTED_TYPE: false,
  });
}
