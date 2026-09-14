/**
 * Share links — SPEC.md section 10.
 *
 * A program is compressed and carried in the URL **fragment**:
 *
 *     https://example.org/#c=<version><deflated><base64url>
 *
 * The fragment is the important detail. Browsers never transmit the part after
 * `#` to a server, by design. So a shared program is not merely "not stored" --
 * it is physically incapable of reaching the host. There is no database to
 * lose, no link to expire, and nothing for a school to have to trust.
 *
 * Layout: one version byte, then raw-deflate of the UTF-8 source. The version
 * byte sits OUTSIDE the compressed data so the compression scheme itself can
 * change later without old links breaking.
 */

export const SHARE_VERSION = 1;
export const FRAGMENT_KEY = 'c';

/**
 * Long URLs get silently truncated by Google Classroom, Canvas and most email
 * clients. Browsers cope with far more, but the student would never find out
 * from the browser -- they would find out from a classmate opening half a
 * program. Warn well before that.
 */
export const LENGTH_WARNING = 12000;

/**
 * Hard ceiling on how much a share link may expand to.
 *
 * Deflate can turn a few hundred bytes into hundreds of megabytes -- a "zip
 * bomb". Without a limit, opening a crafted link would exhaust memory and kill
 * the tab. A real classroom program is a few kilobytes, so half a megabyte is
 * generous by two orders of magnitude and still nowhere near dangerous.
 */
export const MAX_DECOMPRESSED = 512 * 1024;

/* ---------------------------------------------------------- base64url ---- */

/** @param {Uint8Array} bytes */
function toBase64Url(bytes) {
  let binary = '';
  const CHUNK = 0x8000;              // apply() has an argument-count limit
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** @param {string} text @returns {Uint8Array} */
function fromBase64Url(text) {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  const binary = atob(b64 + pad);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/* ------------------------------------------------------------ deflate ---- */

async function deflateRaw(bytes) {
  const stream = new Blob([bytes]).stream()
    .pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Inflate, refusing to keep going past MAX_DECOMPRESSED.
 *
 * Read chunk by chunk rather than with `new Response(stream).arrayBuffer()`:
 * that convenience buffers the whole output first, which is the very thing
 * that has to be prevented here.
 */
async function inflateRaw(bytes, limit = MAX_DECOMPRESSED) {
  const stream = new Blob([bytes]).stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();

  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new Error(
          `This share link expands to more than ${Math.round(limit / 1024)} KB, `
          + 'which is far larger than any real program. It has been ignored.',
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }

  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/* -------------------------------------------------------------- codec ---- */

/**
 * @param {string} code
 * @returns {Promise<string>} the fragment payload (no leading "#c=")
 */
export async function encodeShare(code) {
  const source = new TextEncoder().encode(code);
  const compressed = await deflateRaw(source);
  const payload = new Uint8Array(compressed.length + 1);
  payload[0] = SHARE_VERSION;
  payload.set(compressed, 1);
  return toBase64Url(payload);
}

/**
 * @param {string} payload
 * @returns {Promise<string>} the original source
 * @throws if the payload is malformed or from a future version
 */
export async function decodeShare(payload) {
  const bytes = fromBase64Url(payload);
  if (bytes.length < 2) throw new Error('This share link is empty or damaged.');

  const version = bytes[0];
  if (version !== SHARE_VERSION) {
    throw new Error(
      `This link was made by a newer version of the editor (format ${version}).`,
    );
  }

  const source = await inflateRaw(bytes.subarray(1));
  return new TextDecoder().decode(source);
}

/* ----------------------------------------------------------- URL glue ---- */

/**
 * Build a full share URL from a base location.
 * @param {string} code
 * @param {string} baseUrl
 */
export async function buildShareUrl(code, baseUrl) {
  const payload = await encodeShare(code);
  const url = new URL(baseUrl);
  url.hash = `${FRAGMENT_KEY}=${payload}`;
  return url.toString();
}

/**
 * Read a shared program out of a location hash, if there is one.
 * @param {string} hash e.g. "#c=abc123"
 * @returns {Promise<string|null>}
 */
export async function readShareFromHash(hash) {
  if (!hash || hash.length < 2) return null;
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const payload = params.get(FRAGMENT_KEY);
  if (!payload) return null;
  return decodeShare(payload);
}
