import { describe, expect, it } from 'vitest';
import { EMBED_LINK_TEXT, sanitizeArticleHtml } from './sanitize';

// TID-019 AC5 and AC6, spec 10.5. The sanitiser is the one place feed HTML is cleaned; the E2E
// suite renders the same corpus in a real browser and watches for dialogs and a global canary.

const URL = 'https://example.com/blog/post/1';
const clean = (html: string, url: string | null = URL) => {
  const box = document.createElement('div');
  box.innerHTML = sanitizeArticleHtml(html, url);
  return box;
};

const FORBIDDEN = 'script, iframe, style, form, input, svg, math, object, embed, base, meta, link';

const CORPUS: Record<string, string> = {
  'script tag': '<p>a</p><script>window.__pwned = 1</script>',
  'img onerror': '<img src="https://e.com/x.png" onerror="window.__pwned=1">',
  'javascript: link': '<a href="javascript:window.__pwned=1">click</a>',
  'JaVa\\nScript: link': '<a href="jav&#x0A;ascript:window.__pwned=1">click</a>',
  'data: link': '<a href="data:text/html,<script>1</script>">click</a>',
  iframe: '<iframe src="https://video.example/embed/1"></iframe>',
  'iframe srcdoc': '<iframe srcdoc="<script>parent.__pwned=1</script>"></iframe>',
  'svg onload': '<svg onload="window.__pwned=1"><circle r="1"/></svg>',
  'svg script': '<svg><script>window.__pwned=1</script></svg>',
  style: '<style>body{display:none}</style><p style="color:red">x</p>',
  form: '<form action="https://evil.example"><input name="p"><button>go</button></form>',
  base: '<base href="https://evil.example/"><a href="/x">x</a>',
  'meta refresh': '<meta http-equiv="refresh" content="0;url=https://evil.example">',
  math: '<math><mi xlink:href="javascript:1">x</mi></math>',
  'object and embed': '<object data="x.swf"></object><embed src="x.swf">',
  'body onload': '<body onload="window.__pwned=1"><p>x</p></body>',
  'nested mXSS': '<noscript><p title="</noscript><img src=x onerror=window.__pwned=1>">',
  'on* attribute on allowed tag': '<p onclick="window.__pwned=1" onmouseover="1">x</p>',
};

describe('AC5: the XSS corpus', () => {
  for (const [name, html] of Object.entries(CORPUS)) {
    it(`${name}: no forbidden element, no on* attribute, no script URL`, () => {
      const box = clean(html);
      expect(box.querySelectorAll(FORBIDDEN)).toHaveLength(0);
      for (const el of Array.from(box.querySelectorAll('*'))) {
        for (const attr of Array.from(el.attributes)) {
          expect(attr.name.startsWith('on')).toBe(false);
          expect(['style', 'class', 'id', 'srcdoc']).not.toContain(attr.name);
          if (['href', 'src', 'poster'].includes(attr.name)) {
            expect(attr.value).toMatch(/^(https?:|mailto:)/);
          }
        }
      }
    });
  }

  it('replaces an iframe with an "Open embedded content" link to its address', () => {
    const box = clean('<p>Before</p><iframe src="https://video.example/embed/1"></iframe>');
    const link = box.querySelector('a');
    expect(link?.textContent).toBe(EMBED_LINK_TEXT);
    expect(link?.getAttribute('href')).toBe('https://video.example/embed/1');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(box.querySelector('iframe')).toBeNull();
  });

  it('drops an iframe with no usable address, and one that points at javascript:', () => {
    expect(clean('<iframe></iframe>').textContent).toBe('');
    expect(clean('<iframe src="javascript:1"></iframe>').querySelector('a')).toBeNull();
  });

  it('keeps ordinary article markup', () => {
    const box = clean(
      '<h2>Head</h2><p>Some <strong>bold</strong> and <em>it</em>.</p><ul><li>a</li></ul>' +
        '<blockquote>q</blockquote><pre><code>x &lt; y</code></pre>' +
        '<table><thead><tr><th>h</th></tr></thead><tbody><tr><td>c</td></tr></tbody></table>' +
        '<figure><img src="https://e.com/a.png" alt="alt"><figcaption>cap</figcaption></figure>',
    );
    for (const tag of [
      'h2',
      'strong',
      'em',
      'ul',
      'blockquote',
      'pre',
      'code',
      'table',
      'figure',
    ]) {
      expect(box.querySelector(tag), tag).not.toBeNull();
    }
    expect(box.querySelector('pre code')?.textContent).toBe('x < y');
  });

  it('every link opens a new tab without opener or referrer', () => {
    const a = clean('<a href="https://e.com/a" target="_self" rel="opener">x</a>').querySelector(
      'a',
    );
    expect(a?.getAttribute('target')).toBe('_blank');
    expect(a?.getAttribute('rel')).toBe('noopener noreferrer nofollow');
  });

  it('video and audio get controls and preload none', () => {
    const box = clean(
      '<video src="https://e.com/v.mp4" autoplay></video><audio src="https://e.com/a.mp3" autoplay></audio>',
    );
    for (const tag of ['video', 'audio']) {
      const el = box.querySelector(tag);
      expect(el?.hasAttribute('controls')).toBe(true);
      expect(el?.getAttribute('preload')).toBe('none');
      expect(el?.hasAttribute('autoplay')).toBe(false);
    }
  });
});

describe('AC6: relative URLs and images', () => {
  it('resolves relative links and images against the entry URL', () => {
    const box = clean(
      '<a href="/about">a</a><a href="next.html">b</a><a href="../up">c</a>' +
        '<img src="/img/a.png"><img src="b.png"><a href="//cdn.example/x">d</a>',
    );
    expect(Array.from(box.querySelectorAll('a')).map((a) => a.getAttribute('href'))).toEqual([
      'https://example.com/about',
      'https://example.com/blog/post/next.html',
      'https://example.com/blog/up',
      'https://cdn.example/x',
    ]);
    expect(Array.from(box.querySelectorAll('img')).map((i) => i.getAttribute('src'))).toEqual([
      'https://example.com/img/a.png',
      'https://example.com/blog/post/b.png',
    ]);
  });

  it('drops a relative URL when the entry has no URL to resolve it against', () => {
    const box = clean('<a href="/about">a</a><img src="/a.png">', null);
    expect(box.querySelector('a')?.hasAttribute('href')).toBe(false);
    expect(box.querySelector('img')?.hasAttribute('src')).toBe(false);
  });

  it('every image is lazy, async and sends no referrer', () => {
    const imgs = Array.from(
      clean('<img src="/a.png"><img src="https://e.com/b.png">').querySelectorAll('img'),
    );
    expect(imgs).toHaveLength(2);
    for (const img of imgs) {
      expect(img.getAttribute('loading')).toBe('lazy');
      expect(img.getAttribute('decoding')).toBe('async');
      expect(img.getAttribute('referrerpolicy')).toBe('no-referrer');
    }
  });

  it('keeps mailto: links and drops data: images', () => {
    const box = clean('<a href="mailto:a@b.example">m</a><img src="data:image/png;base64,AAAA">');
    expect(box.querySelector('a')?.getAttribute('href')).toBe('mailto:a@b.example');
    expect(box.querySelector('img')?.hasAttribute('src')).toBe(false);
  });

  it('strips srcset, width-breaking styles and classes (images are sized by CSS)', () => {
    const img = clean(
      '<img src="/a.png" srcset="/a2.png 2x" style="width:3000px" class="huge" width="3000">',
    ).querySelector('img');
    expect(img?.hasAttribute('srcset')).toBe(false);
    expect(img?.hasAttribute('style')).toBe(false);
    expect(img?.hasAttribute('class')).toBe(false);
  });
});

// Tester additions (TID-019): payloads beyond the engineer's corpus. jsdom is not a browser, so
// the E2E spec renders the same list in Chromium as well.
const SAFE_TAGS = new Set(
  'p br a strong em b i u s blockquote q cite code pre kbd ul ol li dl dt dd h1 h2 h3 h4 h5 h6 hr img picture source figure figcaption table thead tbody tfoot tr th td caption sup sub small abbr time mark del ins details summary video audio div'.split(
    ' ',
  ),
);

function assertInert(out: string): void {
  const box = document.createElement('div');
  box.innerHTML = out;
  for (const el of Array.from(box.querySelectorAll('*'))) {
    expect(SAFE_TAGS.has(el.tagName.toLowerCase()), `tag ${el.tagName}`).toBe(true);
    for (const attr of Array.from(el.attributes)) {
      expect(attr.name.startsWith('on'), `attr ${attr.name}`).toBe(false);
      expect([
        'style',
        'class',
        'id',
        'srcdoc',
        'formaction',
        'xlink:href',
        'srcset',
      ]).not.toContain(attr.name);
      if (['href', 'src', 'poster'].includes(attr.name)) {
        expect(attr.value).toMatch(/^(https?:|mailto:)/);
      }
    }
  }
}

const ADVERSARIAL: Record<string, string> = {
  'leading space javascript href': '<a href=" javascript:window.__pwned=1">x</a>',
  'leading tab/newline javascript href': '<a href="\t\n javascript:window.__pwned=1">x</a>',
  'entity-encoded javascript href': '<a href="&#106;&#97;vascript&colon;window.__pwned=1">x</a>',
  'vbscript href': '<a href="vbscript:msgbox(1)">x</a>',
  'data html src on img': '<img src="data:image/svg+xml,<svg onload=window.__pwned=1>">',
  'svg use':
    '<svg><use href="data:image/svg+xml,<svg id=x xmlns=http://www.w3.org/2000/svg><script>window.__pwned=1</script></svg>#x"/></svg>',
  'svg use xlink': '<svg><use xlink:href="https://evil.example/x.svg#a"/></svg>',
  'style @import': '<style>@import url(https://evil.example/x.css);</style><p>x</p>',
  'style attr css url': '<p style="background:url(https://evil.example/t.gif)">x</p>',
  'style attr expression': '<p style="width:expression(window.__pwned=1)">x</p>',
  'link stylesheet': '<link rel="stylesheet" href="https://evil.example/x.css"><p>x</p>',
  formaction: '<form><button formaction="javascript:window.__pwned=1">go</button></form>',
  'input formaction': '<input type="submit" formaction="javascript:window.__pwned=1" value="go">',
  'mXSS svg style': '<svg></p><style><a id="</style><img src=1 onerror=window.__pwned=1>">',
  'mXSS math mglyph':
    '<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;img src=1 onerror=window.__pwned=1&gt;">',
  'mXSS noscript': '<noscript><style></noscript><img src=x onerror=window.__pwned=1>',
  'mXSS xmp': '<xmp><p title="</xmp><img src=x onerror=window.__pwned=1>">',
  'mXSS textarea': '<textarea></textarea><img src=x onerror=window.__pwned=1>',
  'mXSS template': '<template><img src=x onerror=window.__pwned=1></template>',
  'mXSS form nesting':
    '<form><math><mtext></form><form><mglyph><style></math><img src onerror=window.__pwned=1>',
  'namespace confusion foreignObject':
    '<svg><foreignObject><iframe srcdoc="<script>parent.__pwned=1</script>"></iframe></foreignObject></svg>',
  'details ontoggle': '<details open ontoggle="window.__pwned=1"><summary>x</summary></details>',
  'video onerror and poster js':
    '<video poster="javascript:1" onerror="window.__pwned=1"><source src="javascript:1" onerror="window.__pwned=1"></video>',
  'audio src js':
    '<audio src="javascript:window.__pwned=1" autoplay onloadstart="window.__pwned=1"></audio>',
  'dom clobbering': '<img name="cookie" id="body"><a id="x" name="y">x</a>',
  'protocol-relative link': '<a href="//evil.example/x">x</a><img src="//evil.example/t.gif">',
  'object data': '<object data="javascript:1"></object>',
  'plaintext and listing': '<plaintext><img src=x onerror=window.__pwned=1>',
  'comment break': '<!--><img src=x onerror=window.__pwned=1>-->',
  cdata: '<![CDATA[<img src=x onerror=window.__pwned=1>]]>',
  'null bytes': '<scr\u0000ipt>window.__pwned=1</scr\u0000ipt><a href="java\u0000script:1">x</a>',
  'uppercase and slash attrs': '<IMG/SRC="x"/ONERROR="window.__pwned=1">',
};

describe('tester: adversarial XSS', () => {
  for (const [name, html] of Object.entries(ADVERSARIAL)) {
    it(`${name}: output holds only allowed tags and safe attributes`, () => {
      assertInert(sanitizeArticleHtml(html, URL));
      assertInert(sanitizeArticleHtml(html, null));
    });
    it(`${name}: sanitising the output again changes nothing (no mXSS mutation)`, () => {
      const once = sanitizeArticleHtml(html, URL);
      expect(sanitizeArticleHtml(once, URL)).toBe(once);
    });
  }

  it('a protocol-relative URL resolves against the entry URL scheme, not to a script', () => {
    const box = clean('<a href="//evil.example/x">x</a>');
    expect(box.querySelector('a')?.getAttribute('href')).toBe('https://evil.example/x');
  });
});

// DEF-071: an image with no alt text fails WCAG 1.1.1 (axe image-alt, critical). Feed images
// usually have none, so the sanitiser should add alt="" (decorative) when it is missing.
it.fails('DEF-071: an image with no alt attribute gets alt=""', () => {
  const img = clean('<img src="/a.png">').querySelector('img');
  expect(img?.getAttribute('alt')).toBe('');
});
