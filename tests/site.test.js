const fs = require('fs');
const path = require('path');
const { buildPrivacyPage, buildIndexPage, SITE_BASE } = require('../scripts/site');

const PRIVACY_MD = fs.readFileSync(path.join(__dirname, '..', 'PRIVACY.md'), 'utf8');

describe('buildPrivacyPage', () => {
  const html = buildPrivacyPage(PRIVACY_MD);

  // The whole point of rendering at build time (#79): a hand-maintained copy
  // would drift from PRIVACY.md, and the store listings point at this page as
  // the authoritative policy.
  test('renders the real PRIVACY.md, not a copy', () => {
    expect(html).toContain('FeedMe has no server');
    expect(html).toContain('storage.session');
    expect(html).toContain('menu-globalmenucdn.je-apis.com');
  });

  test('renders markdown structure rather than escaping it', () => {
    expect(html).toMatch(/<h1[^>]*>FeedMe — Privacy Policy<\/h1>/);
    expect(html).toContain('<table>');
    expect(html).toContain('<strong>');
    expect(html).not.toContain('## What FeedMe reads');
  });

  // Chrome and AMO both require the policy to state these; if the headings ever
  // get reworded in PRIVACY.md this test is the tripwire.
  test('carries the store-required limited-use statements', () => {
    expect(html).toContain('not sold');
    expect(html).toContain('creditworthiness');
    expect(html).toContain('Data sharing and sale');
  });

  test('is a complete standalone document', () => {
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('<html lang="en"');
    expect(html).toContain('</html>');
    expect(html).toMatch(/<title>[^<]*Privacy[^<]*<\/title>/i);
    expect(html).toContain('name="viewport"');
  });

  // A privacy policy that phones out to a CDN for a font while claiming the
  // extension transmits nothing would be an embarrassing contradiction, and
  // reviewers do look. Everything must be inline.
  test('requests nothing from any external host', () => {
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\/(?!(www\.)?(ubereats|deliveroo|just-eat)|uk\.api|menu-globalmenucdn|github\.com\/comicmuse)/);
    expect(html).not.toMatch(/<link[^>]+stylesheet/i);
    expect(html).toContain('<style>');
  });

  test('adapts to the reader\'s colour scheme', () => {
    expect(html).toContain('prefers-color-scheme: dark');
  });
});

describe('buildIndexPage', () => {
  const html = buildIndexPage();

  test('links to the privacy policy with a path that works under the project base', () => {
    expect(html).toContain(`${SITE_BASE}privacy/`);
  });

  test('is a complete standalone document', () => {
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toMatch(/<title>[^<]*FeedMe[^<]*<\/title>/i);
  });
});

describe('the published site', () => {
  // docs/ holds superpowers specs, live-probe findings and the store listing
  // copy with its reviewer notes. Publishing from main:/docs would have put all
  // of it on the public internet, which is why this builds a curated directory
  // instead. This test fails if anyone points the build at docs/.
  test('never renders anything from docs/', () => {
    const pages = [buildPrivacyPage(PRIVACY_MD), buildIndexPage()].join('\n');
    for (const marker of ['superpowers', 'listing-copy', 'Reviewer note', 'single-purpose statement']) {
      expect(pages).not.toContain(marker);
    }
  });
});
