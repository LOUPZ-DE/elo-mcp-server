import type { Response } from 'express';
import { config } from './runtimeConfig.js';

// Server-rendered pages for the browser half of the OAuth flow: the login form
// and its error pages. Inline CSS, no build step, no external requests.
//
// Deliberately no webfont link. The LOUPZ display face is Reddit Sans, and
// pulling it from fonts.googleapis.com would make every login contact Google —
// not something to add to an authentication page in a German deployment
// without asking. The stack below uses Reddit Sans when it is installed
// locally and falls back to the platform UI face otherwise; the palette and
// the geometry carry the brand either way.

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLES = `
  :root {
    --navy: #000130;
    --navy-60: #666783;
    --navy-10: #f0f1f5;
    --lime: #b7e000;
    --pink: #e93562;
    --white: #fff;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.5rem;
    background: var(--navy);
    color: var(--navy);
    font-family: 'Reddit Sans', 'Reddit Sans Condensed', system-ui, -apple-system, 'Segoe UI', sans-serif;
    font-size: 16px;
    line-height: 1.5;
  }
  .card {
    width: 100%;
    max-width: 400px;
    background: var(--white);
    border-radius: 14px;
    overflow: hidden;
    box-shadow: 0 24px 60px rgba(0, 1, 48, 0.55);
  }
  .accent { height: 6px; background: linear-gradient(90deg, var(--lime) 0%, var(--lime) 62%, var(--pink) 62%); }
  .inner { padding: 2rem 1.75rem 1.75rem; }
  h1 {
    margin: 0 0 0.25rem;
    font-size: 1.6rem;
    font-weight: 700;
    letter-spacing: -0.02em;
    text-transform: uppercase;
    font-stretch: condensed;
  }
  .sub { margin: 0 0 1.5rem; color: var(--navy-60); font-size: 0.9rem; }
  label {
    display: block;
    margin: 1rem 0 0.35rem;
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--navy-60);
  }
  input {
    width: 100%;
    padding: 0.65rem 0.8rem;
    font: inherit;
    color: var(--navy);
    background: var(--navy-10);
    border: 1px solid transparent;
    border-radius: 8px;
  }
  input:focus { outline: none; border-color: var(--navy); background: var(--white); }
  button {
    width: 100%;
    margin-top: 1.5rem;
    padding: 0.75rem;
    font: inherit;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--navy);
    background: var(--lime);
    border: 0;
    border-radius: 8px;
    cursor: pointer;
  }
  button:hover { filter: brightness(1.06); }
  button:active { transform: translateY(1px); }
  .error {
    margin-top: 1.25rem;
    padding: 0.7rem 0.85rem;
    border-left: 4px solid var(--pink);
    border-radius: 0 8px 8px 0;
    background: rgba(233, 53, 98, 0.09);
    color: var(--navy);
    font-size: 0.85rem;
  }
  .meta {
    margin-top: 1.75rem;
    padding-top: 1rem;
    border-top: 1px solid var(--navy-10);
    color: var(--navy-60);
    font-size: 0.72rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  code { font-family: ui-monospace, 'Cascadia Mono', Menlo, monospace; font-size: 0.85em; }
`;

export function page(title: string, body: string): string {
  const serverName = config().OAUTH_SERVER_NAME;
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)} · ${escapeHtml(serverName)}</title>
<style>${STYLES}</style>
</head>
<body>
  <div class="card">
    <div class="accent"></div>
    <div class="inner">${body}</div>
  </div>
</body>
</html>`;
}

export function renderErrorPage(
  res: Response,
  status: number,
  title: string,
  detail: string,
): void {
  const body = `<h1>${escapeHtml(title)}</h1>
    <div class="error">${escapeHtml(detail)}</div>
    <div class="meta">${escapeHtml(config().OAUTH_SERVER_NAME)}</div>`;
  res.set('Cache-Control', 'no-store').status(status).send(page(title, body));
}
