// Builds the public site published to https://comicmuse.net/feedme/.
//
// The only reason this exists is the privacy policy: Chrome, Edge and AMO all
// require a stable public URL for it, and a repo file is not submittable (#79).
//
// Two rules govern everything here.
//
// 1. **PRIVACY.md is the single source of truth.** The policy is rendered from
//    it at build time rather than kept as a second HTML copy, because a copy
//    would drift from the file the repo treats as authoritative — and the store
//    listings point at this page as the policy of record.
//
// 2. **Only what this file emits gets published.** `docs/` holds design specs,
//    live-probe findings and store copy with reviewer notes. Pointing GitHub
//    Pages at `main:/docs` — the usual shortcut — would publish all of it. The
//    workflow uploads the output of this build and nothing else.
//
// Everything is inlined: no script tags, no external stylesheet, no web font. A
// privacy policy that claims the extension transmits nothing has no business
// making third-party requests to render itself.

// markdown-it rather than marked: it is dual-published, so it can be `require`d
// from the CommonJS these scripts and their Jest tests are written in. `html`
// stays false — PRIVACY.md is ours, but there is no reason for a renderer of a
// privacy policy to be able to emit raw HTML.
const markdownIt = require('markdown-it');

const md = markdownIt({ html: false, linkify: true, typographer: false });

// Project Pages live under /<repo>/, and comicmuse.net is bound to the user
// site, so this site is served at comicmuse.net/feedme/ rather than at a root.
// Absolute paths therefore need the prefix; relative links inside the policy
// would break under it.
const SITE_BASE = '/feedme/';

const CSS = `
  :root {
    color-scheme: light dark;
    --bg: #fdfcfa;
    --fg: #1b1a17;
    --muted: #5f5b53;
    --rule: #e3ded4;
    --accent: #b4531f;
    --code-bg: #f1ede4;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #16151a;
      --fg: #ece9e3;
      --muted: #a39e95;
      --rule: #2e2c33;
      --accent: #e8925a;
      --code-bg: #22212a;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 3rem 1.25rem 5rem;
    background: var(--bg);
    color: var(--fg);
    font: 16px/1.65 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    -webkit-text-size-adjust: 100%;
  }
  main { max-width: 42rem; margin: 0 auto; }
  h1 { font-size: 1.9rem; line-height: 1.2; margin: 0 0 .5rem; letter-spacing: -.02em; }
  h2 {
    font-size: 1.15rem;
    margin: 2.5rem 0 .75rem;
    padding-top: 1.25rem;
    border-top: 1px solid var(--rule);
    letter-spacing: -.01em;
  }
  p, li { color: var(--fg); }
  a { color: var(--accent); }
  code {
    background: var(--code-bg);
    padding: .12em .35em;
    border-radius: 3px;
    font: .875em/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  table { border-collapse: collapse; width: 100%; margin: 1.25rem 0; font-size: .94rem; }
  th, td { text-align: left; padding: .55rem .7rem; border-bottom: 1px solid var(--rule); vertical-align: top; }
  th { font-weight: 600; color: var(--muted); }
  .table-wrap { overflow-x: auto; }
  footer {
    max-width: 42rem;
    margin: 4rem auto 0;
    padding-top: 1.25rem;
    border-top: 1px solid var(--rule);
    color: var(--muted);
    font-size: .875rem;
  }
  footer a { color: inherit; }
  .lede { color: var(--muted); font-size: 1.05rem; }
`;

function layout({ title, description, body }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${description}">
<style>${CSS}</style>
</head>
<body>
<main>
${body}
</main>
<footer>
<p>FeedMe is a browser extension with no server, no account and no telemetry.
Source on <a href="https://github.com/comicmuse/feedme">GitHub</a>.
Contact <a href="mailto:feedme@comicmuse.net">feedme@comicmuse.net</a>.</p>
</footer>
</body>
</html>
`;
}

// Tables are the one element that can overflow a phone screen, and a horizontal
// scrollbar on the whole page is worse than one on the table.
function wrapTables(html) {
  return html.replace(/<table>[\s\S]*?<\/table>/g, (t) => `<div class="table-wrap">${t}</div>`);
}

function buildPrivacyPage(markdown) {
  const body = wrapTables(md.render(markdown));
  return layout({
    title: 'Privacy Policy — FeedMe',
    description: 'FeedMe has no server, no account and no telemetry. What the extension reads, stores and sends.',
    body,
  });
}

function buildIndexPage() {
  const body = `<h1>FeedMe</h1>
<p class="lede">A browser extension that compares the price of a takeaway order
across Uber Eats, Deliveroo and Just Eat — including the same restaurant's other
nearby branches, which are often priced differently.</p>
<p>Everything happens in your browser. There is no server, no account, no
analytics and no telemetry.</p>
<h2>Links</h2>
<ul>
<li><a href="${SITE_BASE}privacy/">Privacy policy</a></li>
<li><a href="https://github.com/comicmuse/feedme">Source code on GitHub</a></li>
<li><a href="mailto:feedme@comicmuse.net">feedme@comicmuse.net</a></li>
</ul>`;
  return layout({
    title: 'FeedMe — compare takeaway prices across delivery platforms',
    description: 'A browser extension that compares a takeaway order across Uber Eats, Deliveroo and Just Eat.',
    body,
  });
}

module.exports = { buildPrivacyPage, buildIndexPage, SITE_BASE };
