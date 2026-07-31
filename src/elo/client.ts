import axios, { AxiosInstance, AxiosError } from 'axios';
import { logger } from '../utils/logger.js';
import { resolveStreamUrl } from './streamUrl.js';
import type { LoginResponse } from './types.js';

/** The document exceeded the configured size cap. */
export class EloContentTooLargeError extends Error {
  readonly code = 'CONTENT_TOO_LARGE';
}

/**
 * The content URL was rejected by IX — these URLs are minted per session and
 * expire within minutes, so the caller should re-run `checkoutDoc` for a fresh
 * one and try once more.
 */
export class EloStaleStreamError extends Error {
  readonly code = 'STALE_STREAM_URL';
}

export interface DownloadedFile {
  data: Buffer;
  contentType?: string;
  contentLength?: number;
  fileName?: string;
}

export interface DownloadOptions {
  maxBytes: number;
  timeoutMs: number;
}

export interface EloClientConfig {
  baseUrl: string;
  username: string;
  password: string;
  basicAuthUser?: string;
  basicAuthPass?: string;
  language: string;
  country: string;
  timeZone: string;
}

const SESSION_REFRESH_MS = 8 * 60 * 1000; // re-login after 8 min (IX default timeout ≈ 10 min)

export class EloClient {
  private readonly config: EloClientConfig;
  private readonly http: AxiosInstance;
  private readonly basicAuthHeader: string;
  private sessionId: string | null = null;
  private ticket: string | null = null;
  private clientInfo: Record<string, unknown> | null = null;
  private eloApproved: string | null = null;
  private loginTimestamp = 0;

  constructor(config: EloClientConfig) {
    this.config = config;
    const baUser = config.basicAuthUser ?? config.username;
    const baPass = config.basicAuthPass ?? config.password;
    this.basicAuthHeader = 'Basic ' + Buffer.from(`${baUser}:${baPass}`).toString('base64');
    this.http = axios.create({
      baseURL: config.baseUrl,
      headers: { 'Content-Type': 'application/json' },
      timeout: 30_000,
    });
  }

  async login(): Promise<void> {
    const body = {
      ci: {
        language: this.config.language,
        country: this.config.country,
        timeZone: this.config.timeZone,
      },
      userName: this.config.username,
      userPwd: this.config.password,
      clientComputer: 'MCP-Server',
    };

    logger.debug({ baseUrl: this.config.baseUrl }, 'ELO login: sending');
    const response = await this.http.post<LoginResponse>(
      '/rest/IXServicePortIF/login',
      body,
      { headers: { Authorization: this.basicAuthHeader } },
    );

    // ELO IX returns HTTP 200 with an `exception` body on bad credentials
    // (and still sets a JSESSIONID cookie for an anonymous session, which is
    // useless). We must inspect the body, not the cookie, to know it worked.
    const exception = (response.data as { exception?: unknown })?.exception;
    if (exception) {
      const msg =
        typeof exception === 'string'
          ? exception
          : ((exception as { message?: string })?.message ?? JSON.stringify(exception));
      throw new Error(`ELO login rejected: ${msg}`);
    }

    const setCookie = response.headers['set-cookie'];
    if (Array.isArray(setCookie)) {
      const jsession = setCookie.find((c) => c.includes('JSESSIONID'));
      if (jsession) {
        const match = jsession.match(/JSESSIONID=([^;]+)/);
        if (match) this.sessionId = match[1] ?? null;
      }
    }

    // ELO IX REST authenticates subsequent calls via a session ticket returned in
    // result.clientInfo.ticket. The JSESSIONID cookie alone is unreliable (proxies
    // strip it, loadbalancers re-balance). Sending the ticket via x-ELOIX-Ticket
    // is the documented mechanism. The full clientInfo must also be echoed in the
    // body of every subsequent call as `ci`.
    const clientInfo = (response.data?.result?.clientInfo ?? null) as
      | (Record<string, unknown> & { ticket?: string })
      | null;
    this.clientInfo = clientInfo;
    this.ticket = (clientInfo?.ticket as string | undefined) ?? null;

    if (!this.sessionId && !this.ticket) {
      throw new Error(
        'ELO login succeeded but neither JSESSIONID cookie nor clientInfo.ticket was returned.',
      );
    }

    // ELO IX echoes the elo-approved value or expects a fixed "true" once the consent dialog
    // has been accepted server-side. Default to "true" if no header was set.
    const approvedHeader = response.headers['elo-approved'];
    this.eloApproved = typeof approvedHeader === 'string' ? approvedHeader : 'true';

    this.loginTimestamp = Date.now();
    logger.info({ haveTicket: !!this.ticket, haveCookie: !!this.sessionId }, 'ELO login successful');
  }

  private authHeaders(): Record<string, string> {
    // nginx in front of IX requires HTTP Basic Auth on every path except /login.
    // The IX session itself rides on the JSESSIONID cookie (IX returns the
    // literal string "ticket_from_cookie" for the ticket field, indicating
    // cookie-based sessions — sending x-ELOIX-Ticket has no effect here).
    const headers: Record<string, string> = {
      Authorization: this.basicAuthHeader,
      'elo-approved': this.eloApproved ?? 'true',
    };
    if (this.sessionId) headers.Cookie = `JSESSIONID=${this.sessionId}`;
    return headers;
  }

  private async ensureSession(): Promise<void> {
    if ((!this.sessionId && !this.ticket) || Date.now() - this.loginTimestamp > SESSION_REFRESH_MS) {
      await this.login();
    }
  }

  async request<T>(endpoint: string, body: unknown): Promise<T> {
    await this.ensureSession();
    const withCi = this.injectCi(body);
    try {
      const response = await this.http.post<T>(endpoint, withCi, { headers: this.authHeaders() });
      this.assertNoException(response.data, endpoint);
      return response.data;
    } catch (err) {
      if (this.isInvalidSession(err)) {
        logger.warn('ELO session invalid — re-authenticating and retrying once');
        this.sessionId = null;
        this.ticket = null;
        this.clientInfo = null;
        await this.login();
        const retry = await this.http.post<T>(endpoint, this.injectCi(body), {
          headers: this.authHeaders(),
        });
        this.assertNoException(retry.data, endpoint);
        return retry.data;
      }
      throw this.enrichAxiosError(err, endpoint);
    }
  }

  /**
   * Fetch a document's bytes from an IX content URL.
   *
   * Deliberately not routed through `request()`: that method injects `ci`,
   * inspects the body for an `exception` field and replays on session loss —
   * all correct for a JSON POST and all wrong for a binary GET. The replay in
   * particular is worse than useless here, because the URL was minted for the
   * session that just died and cannot succeed a second time. Stale URLs are
   * surfaced as `EloStaleStreamError` so the caller can mint a new one.
   *
   * Lives on the client so it can use the private `authHeaders()`. Exposing
   * those instead would put Basic credentials and the session cookie in caller
   * code with nothing stopping them being sent to another host.
   */
  async download(rawUrl: string, opts: DownloadOptions): Promise<DownloadedFile> {
    await this.ensureSession();

    // Re-anchors onto ELO_BASE_URL's origin, so our credentials can only ever
    // travel to the configured host. See streamUrl.ts.
    const url = resolveStreamUrl(this.config.baseUrl, rawUrl);

    try {
      const response = await this.http.get<ArrayBuffer>(url, {
        responseType: 'arraybuffer',
        timeout: opts.timeoutMs,
        maxContentLength: opts.maxBytes,
        maxBodyLength: opts.maxBytes,
        // Axios has historically forwarded `Authorization` across cross-host
        // redirects. With three credentials on every request, following a
        // redirect blindly is a leak waiting to happen.
        maxRedirects: 0,
        headers: {
          ...this.authHeaders(),
          Accept: '*/*',
          // The instance default is application/json, which is nonsense on a
          // bodyless GET and upsets some servlet filters.
          'Content-Type': undefined,
        },
      });

      const data = Buffer.from(response.data);
      const headers = response.headers as Record<string, string | undefined>;
      logger.debug(
        { bytes: data.length, contentType: headers['content-type'] },
        'ELO document downloaded',
      );

      return {
        data,
        contentType: headers['content-type'],
        contentLength: data.length,
        fileName: parseFileName(headers['content-disposition']),
      };
    } catch (err) {
      throw this.mapDownloadError(err, url);
    }
  }

  private mapDownloadError(err: unknown, url: string): unknown {
    if (!axios.isAxiosError(err)) return err;

    // Axios signals the cap differently across versions and across the moment
    // it trips (declared Content-Length vs. mid-stream), and none of those
    // variants carries an HTTP status. Match the code *and* the message, or an
    // oversized document surfaces as an unhelpful "HTTP undefined".
    if (
      err.code === 'ERR_FR_MAX_CONTENT_LENGTH_EXCEEDED' ||
      /maxContentLength|maxBodyLength|max(imum)? content length/i.test(err.message ?? '')
    ) {
      return new EloContentTooLargeError('Document exceeds the configured size limit.');
    }

    const status = err.response?.status;
    if (status === 401 || status === 403 || status === 404 || status === 410) {
      return new EloStaleStreamError(
        `ELO refused the content URL (HTTP ${status}) — it has most likely expired.`,
      );
    }
    // A 3xx surfaces here because maxRedirects is 0; that is a configuration
    // signal, not a transient failure, so say what happened.
    if (status && status >= 300 && status < 400) {
      return new Error(
        `ELO content URL redirected (HTTP ${status}); refusing to follow it with credentials attached.`,
      );
    }

    // With responseType 'arraybuffer' an error body arrives as a Buffer, and
    // the generic enricher would JSON-stringify it into a wall of byte values.
    const body = err.response?.data;
    if (body instanceof ArrayBuffer || Buffer.isBuffer(body)) {
      const text = Buffer.from(body as ArrayBuffer)
        .toString('utf8')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return new Error(
        `ELO document download failed (HTTP ${status}): ${text.slice(0, 200) || '(empty body)'}`,
      );
    }
    return this.enrichAxiosError(err, new URL(url).pathname);
  }

  private injectCi(body: unknown): unknown {
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const obj = body as Record<string, unknown>;
      if (obj.ci === undefined) {
        return { ci: this.minimalCi(), ...obj };
      }
    }
    return body;
  }

  // ELO IX requires `ci` on every call, but only a small set of fields is
  // expected back. Echoing the full clientInfo from the login response
  // (which contains server-side metadata like appVersion, databaseInfo, …)
  // causes some Tomcat/IX setups to reject the request with an empty 400.
  private minimalCi(): Record<string, unknown> {
    return {
      ticket: this.ticket ?? '',
      language: this.config.language,
      country: this.config.country,
      timeZone: this.config.timeZone,
    };
  }

  private assertNoException(data: unknown, endpoint: string): void {
    const ex = (data as { exception?: unknown })?.exception;
    if (!ex) return;
    const msg =
      typeof ex === 'string' ? ex : ((ex as { message?: string })?.message ?? JSON.stringify(ex));
    throw new Error(`ELO ${endpoint} rejected: ${msg}`);
  }

  private enrichAxiosError(err: unknown, endpoint: string): unknown {
    if (!axios.isAxiosError(err)) return err;
    const status = err.response?.status;
    const data = err.response?.data;
    let detail: string;
    if (typeof data === 'string') {
      detail = data.slice(0, 500);
    } else if (data && typeof data === 'object') {
      const ex = (data as { exception?: unknown }).exception;
      detail =
        typeof ex === 'string'
          ? ex
          : ((ex as { message?: string })?.message ?? JSON.stringify(data).slice(0, 500));
    } else {
      detail = err.message;
    }
    return new Error(`ELO ${endpoint} failed (HTTP ${status}): ${detail}`);
  }

  private isInvalidSession(err: unknown): boolean {
    if (!axios.isAxiosError(err)) return false;
    if (err.response?.status === 401) return true;
    const data = (err as AxiosError<{ exception?: { message?: string; name?: string } }>)
      .response?.data;
    const message = data?.exception?.message ?? data?.exception?.name ?? '';
    return message.includes('INVALID_SESSION') || message.includes('2001');
  }

  get baseUrl(): string {
    return this.config.baseUrl;
  }
}

/** Pull the filename out of a Content-Disposition header, if there is one. */
function parseFileName(disposition?: string): string | undefined {
  if (!disposition) return undefined;
  // RFC 5987 form first — it carries the correctly encoded name.
  const encoded = disposition.match(/filename\*=(?:UTF-8'')?([^;]+)/i);
  if (encoded?.[1]) {
    try {
      return decodeURIComponent(encoded[1].replace(/^"|"$/g, ''));
    } catch {
      /* fall through to the plain form */
    }
  }
  const plain = disposition.match(/filename="?([^";]+)"?/i);
  return plain?.[1];
}
