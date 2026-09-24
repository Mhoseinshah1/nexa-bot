import { randomBytes } from 'node:crypto';

/**
 * One file on its way to Telegram as an upload, beside the request's other fields.
 *
 * `multipart/form-data` is the only way the Bot API takes BYTES: `sendPhoto` and
 * `sendDocument` accept a `file_id`, a URL, or a part named after the media field.
 * A URL is out — it would mean hosting the image somewhere Telegram can fetch it,
 * which is a public endpoint serving customers' subscription codes — and there is no
 * `file_id` for a file this installation has just rendered.
 *
 * The encoder is written here rather than taken from `FormData` + `Blob` because the
 * transport must be able to state, in a test, exactly what bytes it puts on the wire:
 * the boundary, the field order, the filename and the content type of the part. The
 * platform `FormData` decides those for itself and exposes none of them.
 */
export interface MultipartFilePart {
  /** The form field Telegram reads the media from: `photo` or `document`. */
  readonly field: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

export interface MultipartBody {
  /** The `Content-Type` header, boundary included. */
  readonly contentType: string;
  readonly body: Uint8Array;
}

const CRLF = '\r\n';

/**
 * A boundary no field or file can contain by accident.
 *
 * Sixteen random bytes, hex-encoded, under a fixed prefix: RFC 2046 caps a boundary
 * at 70 characters and this is 43. Random per request rather than a constant, because
 * a constant boundary is one a caption or a filename could be made to contain, and a
 * body that contains its own boundary is a body Telegram parses as two.
 */
function newBoundary(): string {
  return `----NexaFormBoundary${randomBytes(16).toString('hex')}`;
}

/**
 * A header value with the two characters that would let it close its own quotes or
 * start a new header. The file name is the only caller-influenced value here, and it
 * is this installation's own constant today; the escaping is what keeps that "today".
 */
function quoted(value: string): string {
  return value.replace(
    /["\r\n\\]/g,
    (char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`,
  );
}

/**
 * The text fields and one file as a `multipart/form-data` body.
 *
 * Field order is the insertion order of `fields`, followed by the file. Telegram does
 * not care about the order; the test that pins this body does, so that a change to it
 * is a visible diff rather than an invisible one.
 *
 * Every text field is sent WITHOUT a content type. RFC 7578 says a part with no
 * `Content-Type` is `text/plain` in the form's charset, and Telegram treats the
 * request as UTF-8 — which is also what `JSON.stringify` on the JSON path has always
 * produced, so a Persian caption reads the same whichever path carried it.
 */
export function encodeMultipart(
  fields: Readonly<Record<string, string>>,
  file: MultipartFilePart,
): MultipartBody {
  const boundary = newBoundary();
  const chunks: Buffer[] = [];

  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}${CRLF}` +
          `Content-Disposition: form-data; name="${quoted(name)}"${CRLF}${CRLF}` +
          `${value}${CRLF}`,
        'utf8',
      ),
    );
  }

  chunks.push(
    Buffer.from(
      `--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="${quoted(file.field)}"; filename="${quoted(file.fileName)}"${CRLF}` +
        `Content-Type: ${file.mimeType}${CRLF}${CRLF}`,
      'utf8',
    ),
    Buffer.from(file.bytes.buffer, file.bytes.byteOffset, file.bytes.byteLength),
    Buffer.from(`${CRLF}--${boundary}--${CRLF}`, 'utf8'),
  );

  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.concat(chunks),
  };
}
