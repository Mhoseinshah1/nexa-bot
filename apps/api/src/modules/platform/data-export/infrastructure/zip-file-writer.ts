import { createWriteStream, type WriteStream } from 'node:fs';
import { once } from 'node:events';
import { crc32, createDeflateRaw } from 'node:zlib';
import { DATA_EXPORT_ERROR_CODES, NexaError } from '@nexa/contracts';

/**
 * A ZIP archive written to disk as a STREAM (APPNOTE): per entry a local header with the
 * data-descriptor flag, the deflated bytes as they are produced, then the descriptor with the
 * CRC and sizes; a central directory and the end record at the close. A ledger of millions of
 * rows is never held in memory.
 *
 * No ZIP64: a CSV (or the whole archive) past 4 GiB is refused with `data_export.too_large`
 * rather than written corrupt. Every timestamp is the DOS epoch, so the bytes depend only on
 * the contents. File names are UTF-8 (flag 0x0800).
 */

const FOUR_GIB = 0xffffffff;
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1; // 1980-01-01
const FLAGS = 0x0800 | 0x0008; // UTF-8 names, sizes follow in a data descriptor

interface CentralRecord {
  readonly name: Buffer;
  readonly crc: number;
  readonly compressed: number;
  readonly size: number;
  readonly offset: number;
}

function tooLarge(): NexaError {
  return new NexaError({
    kind: 'PRECONDITION_FAILED',
    code: DATA_EXPORT_ERROR_CODES.TOO_LARGE,
    message: 'The export is larger than one ZIP file can hold.',
  });
}

export class ZipFileWriter {
  private readonly out: WriteStream;
  private readonly central: CentralRecord[] = [];
  private offset = 0;
  private failed: Error | null = null;

  constructor(path: string) {
    this.out = createWriteStream(path, { mode: 0o600 });
    this.out.on('error', (error) => {
      this.failed = error;
    });
  }

  private async write(chunk: Buffer): Promise<void> {
    if (this.failed !== null) throw this.failed;
    this.offset += chunk.length;
    if (this.offset > FOUR_GIB) throw tooLarge();
    if (!this.out.write(chunk)) await once(this.out, 'drain');
  }

  /**
   * One entry whose content `produce` writes, piece by piece, through the `push` it is given
   * (back-pressured: `push` resolves when the writer can take more).
   */
  async addEntry(
    name: string,
    produce: (push: (part: string | Buffer) => Promise<void>) => Promise<void>,
  ): Promise<void> {
    const nameBytes = Buffer.from(name, 'utf8');
    const start = this.offset;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(FLAGS, 6);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    // crc and both sizes are zero here: the data descriptor carries them.
    local.writeUInt16LE(nameBytes.length, 26);
    await this.write(Buffer.concat([local, nameBytes]));

    const deflate = createDeflateRaw({ level: 6 });
    let crc = 0;
    let size = 0;
    let compressed = 0;
    const pending: Buffer[] = [];
    deflate.on('data', (chunk: Buffer) => pending.push(chunk));
    const flush = async (): Promise<void> => {
      while (pending.length > 0) {
        const chunk = pending.shift() as Buffer;
        compressed += chunk.length;
        await this.write(chunk);
      }
    };
    await produce(async (part) => {
      const data = typeof part === 'string' ? Buffer.from(part, 'utf8') : part;
      if (data.length === 0) return;
      crc = crc32(data, crc);
      size += data.length;
      if (size > FOUR_GIB) throw tooLarge();
      if (!deflate.write(data)) await once(deflate, 'drain');
      await flush();
    });
    const ended = once(deflate, 'end');
    deflate.end();
    await ended;
    await flush();

    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc >>> 0, 4);
    descriptor.writeUInt32LE(compressed, 8);
    descriptor.writeUInt32LE(size, 12);
    await this.write(descriptor);
    this.central.push({ name: nameBytes, crc: crc >>> 0, compressed, size, offset: start });
  }

  /** Writes the central directory and the end record, and closes the file. */
  async finish(): Promise<void> {
    const directoryStart = this.offset;
    for (const entry of this.central) {
      const record = Buffer.alloc(46);
      record.writeUInt32LE(0x02014b50, 0);
      record.writeUInt16LE(20, 4);
      record.writeUInt16LE(20, 6);
      record.writeUInt16LE(FLAGS, 8);
      record.writeUInt16LE(8, 10);
      record.writeUInt16LE(DOS_TIME, 12);
      record.writeUInt16LE(DOS_DATE, 14);
      record.writeUInt32LE(entry.crc, 16);
      record.writeUInt32LE(entry.compressed, 20);
      record.writeUInt32LE(entry.size, 24);
      record.writeUInt16LE(entry.name.length, 28);
      record.writeUInt32LE(entry.offset, 42);
      await this.write(Buffer.concat([record, entry.name]));
    }
    const directorySize = this.offset - directoryStart;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.central.length, 8);
    end.writeUInt16LE(this.central.length, 10);
    end.writeUInt32LE(directorySize, 12);
    end.writeUInt32LE(directoryStart, 16);
    await this.write(end);
    await this.close();
  }

  /** Closes the file without finishing it (a failed export; the caller removes the file). */
  async abort(): Promise<void> {
    await this.close().catch(() => undefined);
  }

  private async close(): Promise<void> {
    if (this.out.closed) return;
    this.out.end();
    await once(this.out, 'close');
    if (this.failed !== null) throw this.failed;
  }

  get bytes(): number {
    return this.offset;
  }
}
