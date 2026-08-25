import { readFileSync } from 'node:fs';
import { logger } from './logger.js';

// The mark MCP clients show next to this server: Notion in its connector list,
// Open WebUI in the tool palette, the MCP Inspector in its header.
//
// Reaching clients two ways, because neither covers everything:
//   - `serverInfo.icons` on `initialize` (MCP 2025-11-25 / SEP-973), which is
//     the transport-agnostic route and the only one that works over stdio;
//   - `GET /icon.png` plus the `icon` field of /.well-known/mcp.json, which is
//     what Notion reads before any OAuth round trip has happened.

export interface ServerIcon {
  bytes: Buffer;
  mimeType: string;
  /** Advertised to clients so they can pick a resolution. */
  sizes: string[];
}

let cached: ServerIcon | null | undefined;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Read the real dimensions out of the file rather than asserting them.
 *
 * A PNG's IHDR is the first chunk and sits at a fixed offset, so this is two
 * reads. It matters because the size is advertised to clients: hard-coding it
 * meant that replacing the icon — the one step this is meant to take — silently
 * started telling clients the wrong thing.
 */
function readPngSize(bytes: Buffer): string | undefined {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined;
  if (bytes.subarray(12, 16).toString('ascii') !== 'IHDR') return undefined;
  return `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;
}

/**
 * Read the icon once, from `assets/` next to the compiled output.
 *
 * Two levels up, because this module sits in `utils/`: that lands on the repo
 * root under tsx (`src/utils` → root), on the same root after a build
 * (`dist/utils` → root), and on `/app/assets` in the image, where the
 * Dockerfile copies `assets` alongside `dist`.
 *
 * A missing or unreadable icon is not fatal. Replacing it is meant to be a
 * single file drop — no code, no config — and a server that refuses to boot
 * over a cosmetic file would be a poor trade.
 */
export function loadIcon(): ServerIcon | undefined {
  if (cached !== undefined) return cached ?? undefined;
  try {
    const bytes = readFileSync(new URL('../../assets/icon.png', import.meta.url));
    const size = readPngSize(bytes);
    if (!size) {
      // Serving a JPEG or an SVG under image/png would leave clients rendering
      // nothing, with no clue why. Say so instead.
      logger.warn('assets/icon.png is not a valid PNG — the server will present itself without an icon');
      cached = null;
      return undefined;
    }
    cached = { bytes, mimeType: 'image/png', sizes: [size] };
    logger.debug({ size, bytes: bytes.length }, 'Server icon loaded');
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err },
      'No assets/icon.png — the server will present itself without an icon',
    );
    cached = null;
  }
  return cached ?? undefined;
}

/**
 * Where clients should fetch the icon from.
 *
 * An absolute URL when the public origin is known, because that is cacheable
 * and keeps `initialize` small. A data URI otherwise — over stdio there is no
 * HTTP server to fetch from, so inlining is the only thing that can work.
 */
export function iconSrc(publicBaseUrl: string | undefined): string | undefined {
  const icon = loadIcon();
  if (!icon) return undefined;
  if (publicBaseUrl) return `${publicBaseUrl}/icon.png`;
  return `data:${icon.mimeType};base64,${icon.bytes.toString('base64')}`;
}
