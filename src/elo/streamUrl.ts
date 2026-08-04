// Turning an IX-supplied content URL into one we can actually fetch.
//
// ELO installations have three parallel URL spaces (BUGFIXES #10), and IX
// happily hands out URLs from the wrong one. Both forms were verified against
// the live instance:
//
//   fileData.stream.url = "getstream?serverid=…&messageid=…&streamid=…"
//     A *bare relative* URL — no leading slash. It resolves against the REST
//     endpoint root, i.e. <ELO_BASE_URL>/rest/getstream. Resolving it against
//     the origin (/getstream) or against the app path (/ix-INSTANCE/getstream)
//     returns 404 from both; only the /rest/ form serves the bytes.
//
//   docs[0].url = "http://<internal-host>:9090/ix-INSTANCE/ix?cmd=…&eticket=…"
//     Absolute, but on the *internal* hostname, which no container outside the
//     server LAN can reach. Its path re-anchored onto the public origin works.
//
// Hence the rules below. Re-anchoring everything onto ELO_BASE_URL's origin
// also means there is no code path that can send our Basic credentials and
// session cookie to a foreign host — that becomes structurally impossible
// rather than merely unlikely.

export class UnsafeStreamUrlError extends Error {
  readonly code = 'UNSAFE_STREAM_URL';
}

export function resolveStreamUrl(baseUrl: string, rawUrl: string): string {
  if (!rawUrl || !rawUrl.trim()) {
    throw new UnsafeStreamUrlError('Empty content URL returned by ELO.');
  }

  const base = new URL(baseUrl);
  const trimmed = rawUrl.trim();

  // A bare relative URL ("getstream?…") belongs to the REST endpoint root.
  // Anything with a leading slash or a scheme is resolved normally and then
  // pinned to our origin.
  const isAbsolute = /^https?:\/\//i.test(trimmed);
  const isOriginRelative = trimmed.startsWith('/');
  const resolutionBase = isAbsolute || isOriginRelative
    ? baseUrl
    : `${baseUrl.replace(/\/$/, '')}/rest/`;

  let parsed: URL;
  try {
    parsed = new URL(trimmed, resolutionBase);
  } catch {
    throw new UnsafeStreamUrlError(`Unparseable content URL: ${rawUrl.slice(0, 120)}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UnsafeStreamUrlError(`Refusing non-HTTP content URL (${parsed.protocol}).`);
  }

  // `new URL` already normalises "..", but a path that still contains a
  // traversal segment after normalisation is malformed and not worth fetching.
  if (parsed.pathname.split('/').includes('..')) {
    throw new UnsafeStreamUrlError('Refusing content URL with a path traversal segment.');
  }

  const anchored = new URL(base.origin);
  anchored.pathname = parsed.pathname;
  anchored.search = parsed.search;
  return anchored.toString();
}

/** True when the URL would have been fetched from a different host than ELO. */
export function isForeignHost(baseUrl: string, rawUrl: string): boolean {
  try {
    return new URL(rawUrl, baseUrl).host !== new URL(baseUrl).host;
  } catch {
    return false;
  }
}
