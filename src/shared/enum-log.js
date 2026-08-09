// Diagnostic logging for the enumeration scrapers.
//
// Every "no branches" outcome has several causes that are indistinguishable once
// the scraper has reported an empty list: the listing never loaded, a login wall
// or bot challenge replaced it, or it loaded fine and the chain genuinely has no
// nearby branch (#112, #105). Downstream all three read as "No branches found".
// These logs make the cause visible in the platform tab's own console — the one
// place the difference still survives — which is what turns an intermittent,
// seemingly-random Firefox failure into something diagnosable.
//
// This is console output, never a decision input: it changes nothing about what
// the scraper reports, so the deterministic-over-heuristic rule does not apply —
// the log may hint, the report may not.

// The page signals that distinguish the failure modes. href and title reveal a
// redirect to a sign-in or challenge page (the leading suspect when logged out);
// readyState reveals a report sent before the page finished loading. Pure over
// its arguments — the global lookup lives in currentPage() — and defensive, so
// logging can never itself throw on a torn-down document (no doc/win, as in the
// service worker, yields {}).
function pageSummary(doc, win) {
  if (!doc || !win) return {};
  try {
    return { href: win.location && win.location.href, readyState: doc.readyState, title: doc.title };
  } catch (_) {
    return {};
  }
}

// The one place globals are touched. Absent in the background worker, hence the
// typeof guards.
function currentPage() {
  return {
    doc: typeof document !== 'undefined' ? document : null,
    win: typeof window !== 'undefined' ? window : null,
  };
}

// One line per enumeration event, always prefixed so a user can grep the console
// for "[FeedMe enum]" and see every platform's fate in one filter.
function enumLog(platform, message, extra = {}) {
  try {
    const { doc, win } = currentPage();
    console.info('[FeedMe enum]', platform, '—', message, { ...pageSummary(doc, win), ...extra });
  } catch (_) {}
}

module.exports = { enumLog, pageSummary };
