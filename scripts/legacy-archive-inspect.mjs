#!/usr/bin/env node
/**
 * The legacy (MirzaBot) archive inspector — WP-D1a. Validates a legacy backup BEFORE
 * anything is loaded, and reports what it is, with no row content.
 *
 *   node scripts/legacy-archive-inspect.mjs --archive PATH
 *        [--password-env NAME] [--engine mariadb|mysql8] [--out DIR [--extract]]
 *        [--require-class synthetic|staging] [--max-dump-bytes N] [--columns]
 *
 * Accepted, and nothing else (each is an evidenced MirzaBot shape, docs/legacy-migration/
 * importer.md §10):
 *   - a plain `.sql`, or a `.sql.gz`, written by `mysqldump`/`mariadb-dump` (header
 *     `-- MySQL dump …` / `-- MariaDB dump …`);
 *   - the same written by MirzaBot's PDO fallback (`cronbot/backupbot.php`
 *     `backupDumpDatabaseWithPdo`: first lines `SET NAMES utf8mb4;`,
 *     `SET FOREIGN_KEY_CHECKS=0;`, `SET SQL_MODE='NO_AUTO_VALUE_ON_ZERO';`);
 *   - `backup_YYYY-MM-DD.zip` holding EXACTLY one entry `backup_YYYY-MM-DD.sql`, stored or
 *     deflated, unencrypted or WinZip AES-256 (method 99, extra 0x9901) — what MirzaBot
 *     revision e4966ff produces with `ZipArchive::EM_AES_256`;
 *   - this repository's SYNTHETIC fixture (`-- SYNTHETIC legacy fixture v1`), which is
 *     reported as synthetic and refused by `--require-class staging`.
 * ZipCrypto, AES-128/192, zip64, multi-disk, several entries or any other name are
 * refused, not guessed at.
 *
 * AES: WinZip AE-1/AE-2 is PBKDF2-HMAC-SHA1 (1000 rounds) → AES-256 in CTR mode with a
 * little-endian counter, authenticated by a 10-byte HMAC-SHA1 over the ciphertext. It is
 * implemented here on `node:crypto` (no external tool, no dependency); the fixtures it is
 * tested against are written by PHP's libzip — MirzaBot's own encoder — not by this code.
 * The HMAC is checked over the whole entry, and an extracted file whose HMAC (or AE-1
 * CRC) does not verify is deleted before the tool exits.
 *
 * The password comes ONLY from the environment variable `--password-env` names. A
 * `--password` flag is refused, and so is any argument equal to the password. It is never
 * printed, logged or written.
 *
 * Output: one JSON document on stdout (and `DIR/archive.json` with `--out`):
 * sha256 of the archive and of the inner dump, container, format, client and server
 * version, engine, tables (names and whether the importer's required columns are there),
 * statement counts, character sets, collations, stored objects, USE/CREATE DATABASE, and
 * `blockers[]`. `--extract` writes the inner dump to `DIR/<entry>` (0600, in a 0700 dir).
 * `--columns` adds `dump.tableColumns`: every table's column NAMES in declaration order —
 * names only, never a type default or a value — so the table inventory
 * (docs/legacy-migration/table-inventory.md) can be drafted from a dump before any load.
 *
 * Exit: 0 ACCEPTED; 2 BLOCKED (the report says why); 64 usage; 1 an I/O failure.
 */
import {
  createHash,
  createCipheriv,
  createHmac,
  pbkdf2Sync,
  getCiphers,
  timingSafeEqual,
} from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  openSync,
  readSync,
  closeSync,
  statSync,
  unlinkSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as zlib from 'node:zlib';

export const SCHEMA = 'nexa-legacy-archive-inspection/v1';

/**
 * The importer's required tables and columns. A mirror of `LEGACY_REQUIRED_COLUMNS`
 * (apps/api/src/modules/platform/legacy-importer/application/source-port.ts); a unit
 * test pins the two equal, so neither can move alone.
 */
export const REQUIRED_COLUMNS = {
  user: ['id', 'Balance', 'limit_usertest'],
  invoice: [
    'id_invoice',
    'id_user',
    'username',
    'Status',
    'is_test',
    'code_panel',
    'code_product',
    'Volume',
    'Service_time',
    'time_unit',
    'is_custom',
    'price_product',
  ],
  product: ['id', 'code_product'],
};

const ZIP_NAME = /^backup_\d{4}-\d{2}-\d{2}\.zip$/u;
const ENTRY_NAME = /^backup_\d{4}-\d{2}-\d{2}\.sql$/u;
const PDO_HEADER = [
  'SET NAMES utf8mb4;',
  'SET FOREIGN_KEY_CHECKS=0;',
  "SET SQL_MODE='NO_AUTO_VALUE_ON_ZERO';",
];
const SYNTHETIC_HEADER = '-- SYNTHETIC legacy fixture v1 (not evidence)';
const SYNTHETIC_TABLE = 'nexa_synthetic_fixture';
const LINE_HEAD_BYTES = 8192;
/**
 * The most a plain or gzipped dump may expand to when no container states its size
 * (`--max-dump-bytes`). A zip is held to its central directory's own uncompressed size
 * instead. Generous for MirzaBot's few-thousand-user database; a gzip bomb stops here.
 */
export const DEFAULT_MAX_DUMP_BYTES = 8 * 1024 ** 3;

class Usage extends Error {}

function fail(code, message) {
  const error = new Error(message);
  error.blocker = code;
  return error;
}

// --- Arguments ----------------------------------------------------------------------------

export function parseArgs(argv, env) {
  const opts = {
    archive: null,
    passwordEnv: null,
    engine: null,
    out: null,
    extract: false,
    columns: false,
    requireClass: null,
    maxDumpBytes: String(DEFAULT_MAX_DUMP_BYTES),
  };
  const takes = new Map([
    ['--max-dump-bytes', 'maxDumpBytes'],
    ['--archive', 'archive'],
    ['--password-env', 'passwordEnv'],
    ['--engine', 'engine'],
    ['--out', 'out'],
    ['--require-class', 'requireClass'],
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (/^--password(=|$)/u.test(arg) || /^-p/u.test(arg)) {
      throw new Usage(
        'a password is never accepted on the command line (argv is world-readable). ' +
          'Put it in an environment variable and pass --password-env NAME.',
      );
    }
    if (arg === '--extract') {
      opts.extract = true;
    } else if (arg === '--columns') {
      opts.columns = true;
    } else if (takes.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value === '' || value.startsWith('--'))
        throw new Usage(`${arg} needs a value.`);
      opts[takes.get(arg)] = value;
      i += 1;
    } else if (arg === '-h' || arg === '--help') {
      throw new Usage('help');
    } else {
      throw new Usage(`unknown argument: ${arg}`);
    }
  }
  if (opts.archive === null) throw new Usage('--archive PATH is required.');
  if (opts.engine !== null && !['mariadb', 'mysql8'].includes(opts.engine)) {
    throw new Usage(`--engine must be mariadb or mysql8, not '${opts.engine}'.`);
  }
  if (opts.requireClass !== null && !['synthetic', 'staging'].includes(opts.requireClass)) {
    throw new Usage(`--require-class must be synthetic or staging, not '${opts.requireClass}'.`);
  }
  if (opts.extract && opts.out === null) throw new Usage('--extract needs --out DIR.');
  if (!/^[1-9][0-9]{0,15}$/u.test(opts.maxDumpBytes)) {
    throw new Usage('--max-dump-bytes must be a positive whole number of bytes.');
  }
  opts.maxDumpBytes = Number(opts.maxDumpBytes);
  let password = null;
  if (opts.passwordEnv !== null) {
    if (!/^[A-Z_][A-Z0-9_]{0,63}$/u.test(opts.passwordEnv)) {
      throw new Usage('--password-env must name an environment variable ([A-Z_][A-Z0-9_]*).');
    }
    password = env[opts.passwordEnv];
    if (password === undefined || password === '') {
      throw new Usage(
        `--password-env ${opts.passwordEnv}: that environment variable is not set or is empty.`,
      );
    }
    // A password typed as an argument as well is already on argv: refuse, and say so
    // without repeating it.
    if (argv.includes(password)) {
      throw new Usage(
        'the password also appears on the command line, which is world-readable. Remove it from argv.',
      );
    }
  }
  return { ...opts, password };
}

// --- The SQL scanner ----------------------------------------------------------------------

/**
 * Reads a dump as bytes, a line at a time, keeping at most LINE_HEAD_BYTES of each line:
 * an extended INSERT can be megabytes long, and what is decided here never needs its data.
 */
export class DumpScanner {
  constructor() {
    this.head = [];
    this.headBytes = 0;
    this.lineNo = 0;
    this.firstLines = [];
    this.lastLine = '';
    this.tables = new Map();
    this.currentTable = null;
    this.insertStatements = {};
    this.charsets = new Set();
    this.collations = new Set();
    this.storedObjects = {};
    this.definer = false;
    this.selectsDatabase = [];
    this.createsDatabase = false;
    this.bytes = 0;
  }

  push(chunk) {
    this.bytes += chunk.length;
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(0x0a, start);
      const end = nl === -1 ? chunk.length : nl;
      if (this.headBytes < LINE_HEAD_BYTES && end > start) {
        const take = chunk.subarray(
          start,
          Math.min(end, start + (LINE_HEAD_BYTES - this.headBytes)),
        );
        this.head.push(take);
        this.headBytes += take.length;
      }
      if (nl === -1) break;
      this.flushLine();
      start = nl + 1;
    }
  }

  end() {
    if (this.headBytes > 0) this.flushLine();
  }

  flushLine() {
    const line = Buffer.concat(this.head).toString('utf8').replace(/\r$/u, '');
    this.head = [];
    this.headBytes = 0;
    this.lineNo += 1;
    if (this.firstLines.length < 40 && line.trim() !== '') this.firstLines.push(line);
    if (line.trim() !== '') this.lastLine = line;
    this.line(line);
  }

  line(line) {
    const insert = /^INSERT\s+(?:IGNORE\s+)?INTO\s+`?([^`\s(]+)`?/iu.exec(line);
    if (insert !== null) {
      this.insertStatements[insert[1]] = (this.insertStatements[insert[1]] ?? 0) + 1;
      return; // row data: never scanned for anything else
    }
    if (/^\s*--/u.test(line)) return;
    const use = /^USE\s+`?([^`;\s]+)`?\s*;/iu.exec(line);
    if (use !== null) this.selectsDatabase.push(use[1]);
    if (/^\s*(?:\/\*!\d+\s+)?CREATE\s+(?:DATABASE|SCHEMA)\b/iu.test(line))
      this.createsDatabase = true;
    if (/\bDEFINER\s*=/iu.test(line)) this.definer = true;
    // A stored object, however its writer spells it: `CREATE … VIEW \`v\``, mysqldump's
    // `/*!50001 VIEW \`v\` …` and `/*!50003 TRIGGER \`t\` …`, a PDO `SHOW CREATE` line.
    // Only statement lines count — a column definition starts with whitespace and a name.
    if (/^(?:CREATE\b|\/\*!\d+\s)/iu.test(line)) {
      const object = /\b(TRIGGER|PROCEDURE|FUNCTION|EVENT|VIEW)\s+`/iu.exec(line);
      if (object !== null) {
        const kind = object[1].toUpperCase();
        this.storedObjects[kind] = (this.storedObjects[kind] ?? 0) + 1;
      }
    }
    for (const m of line.matchAll(/\bCOLLATE\s*=?\s*'?([A-Za-z0-9_]+)/giu))
      this.collations.add(m[1].toLowerCase());
    for (const m of line.matchAll(/\b(?:CHARSET|CHARACTER\s+SET)\s*=?\s*'?([A-Za-z0-9_]+)/giu)) {
      this.charsets.add(m[1].toLowerCase());
    }
    for (const m of line.matchAll(/\bSET\s+NAMES\s+'?([A-Za-z0-9_]+)/giu))
      this.charsets.add(m[1].toLowerCase());
    const create = /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?([^`\s(]+)`?\s*\((.*)$/iu.exec(
      line,
    );
    if (create !== null) {
      this.currentTable = create[1];
      this.tables.set(this.currentTable, new Set());
      // A single-line CREATE TABLE (the synthetic fixture's marker table, PDO output of a
      // one-column table) carries its columns on this same line.
      this.columnsFrom(create[2]);
      if (/\)\s*[^)]*;\s*$/u.test(create[2]) && !/^\s*$/u.test(create[2])) this.currentTable = null;
      return;
    }
    if (this.currentTable !== null) {
      if (/^\s*\)/u.test(line)) {
        this.currentTable = null;
        return;
      }
      this.columnsFrom(line);
    }
  }

  columnsFrom(text) {
    for (const m of text.matchAll(/(?:^|,)\s*`([^`]+)`\s+[A-Za-z]/gu)) {
      this.tables.get(this.currentTable)?.add(m[1]);
    }
  }

  /** The format, from the first lines; null when it is none this tool accepts. */
  format() {
    const lines = this.firstLines;
    const mysql = lines
      .map((l) => /^-- (MySQL|MariaDB) dump\s+(\S+)\s+Distrib\s+(\S+?),?\s/u.exec(l))
      .find(Boolean);
    const server = lines.map((l) => /^-- Server version\s+(.+?)\s*$/u.exec(l)).find(Boolean);
    if (mysql !== undefined) {
      return {
        format: 'mysqldump',
        client: mysql[1] === 'MariaDB' ? 'mariadb-dump' : 'mysqldump',
        clientVersion: mysql[2],
        distrib: mysql[3],
        serverVersion: server?.[1] ?? null,
      };
    }
    if (PDO_HEADER.every((h, i) => lines[i] === h)) {
      return {
        format: 'mirza-pdo-fallback',
        client: 'mirzabot-pdo',
        clientVersion: null,
        distrib: null,
        serverVersion: null,
      };
    }
    if (lines[0] === SYNTHETIC_HEADER) {
      return {
        format: 'synthetic-fixture',
        client: 'nexa-fixture',
        clientVersion: null,
        distrib: null,
        serverVersion: null,
      };
    }
    return null;
  }

  /** Whether the dump ends the way its writer ends one; null when the format has no marker. */
  complete(format) {
    if (format === 'mysqldump') return /^-- Dump completed( on |$)/u.test(this.lastLine);
    if (format === 'mirza-pdo-fallback') return this.lastLine === 'SET FOREIGN_KEY_CHECKS=1;';
    return null;
  }
}

/** mysql | mariadb | unknown, from the server-version line, then from collations. */
export function sourceEngine(serverVersion, collations) {
  if (serverVersion !== null) {
    if (/mariadb/iu.test(serverVersion)) return 'mariadb';
    if (/^\d+\.\d+/u.test(serverVersion)) return 'mysql';
  }
  if ([...collations].some((c) => /_0900_/u.test(c))) return 'mysql';
  if ([...collations].some((c) => /_uca1400_/u.test(c))) return 'mariadb';
  return 'unknown';
}

export function mysqlMajor(serverVersion) {
  const m = /^(\d+)\.(\d+)/u.exec(serverVersion ?? '');
  return m === null ? null : Number(m[1]);
}

// --- ZIP ----------------------------------------------------------------------------------

function readAt(fd, position, length) {
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const n = readSync(fd, buf, done, length - done, position + done);
    if (n === 0) break;
    done += n;
  }
  return buf.subarray(0, done);
}

/**
 * The one entry of a MirzaBot backup zip, from its central directory, cross-checked
 * against its local header. Every shape MirzaBot does not produce is a precise refusal.
 */
export function readZipEntry(path) {
  const size = statSync(path).size;
  const fd = openSync(path, 'r');
  try {
    if (size < 22) throw fail('ZIP_TRUNCATED', 'the file is too short to be a zip.');
    const tailLen = Math.min(size, 22 + 0xffff);
    const tail = readAt(fd, size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd === -1)
      throw fail(
        'ZIP_TRUNCATED',
        'no end-of-central-directory record: the zip is truncated or not a zip.',
      );
    const disk = tail.readUInt16LE(eocd + 4);
    const cdDisk = tail.readUInt16LE(eocd + 6);
    const entriesHere = tail.readUInt16LE(eocd + 8);
    const entries = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (disk !== 0 || cdDisk !== 0 || entriesHere !== entries) {
      throw fail('ZIP_MULTI_DISK', 'a multi-part zip is not a shape MirzaBot produces.');
    }
    if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      throw fail('ZIP64_UNSUPPORTED', 'a zip64 archive is not a shape MirzaBot produces.');
    }
    if (entries !== 1) {
      throw fail(
        'ZIP_ENTRY_COUNT',
        `the zip holds ${entries} entries; a MirzaBot backup holds exactly one.`,
      );
    }
    if (cdOffset + cdSize > size)
      throw fail('ZIP_TRUNCATED', 'the central directory lies past the end of the file.');
    const cd = readAt(fd, cdOffset, cdSize);
    if (cd.length < 46 || cd.readUInt32LE(0) !== 0x02014b50) {
      throw fail('ZIP_TRUNCATED', 'the central directory is damaged.');
    }
    const flags = cd.readUInt16LE(8);
    const method = cd.readUInt16LE(10);
    const crc = cd.readUInt32LE(16);
    const compressedSize = cd.readUInt32LE(20);
    const uncompressedSize = cd.readUInt32LE(24);
    const nameLen = cd.readUInt16LE(28);
    const extraLen = cd.readUInt16LE(30);
    const localOffset = cd.readUInt32LE(42);
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff
    ) {
      throw fail('ZIP64_UNSUPPORTED', 'a zip64 entry is not a shape MirzaBot produces.');
    }
    const name = cd.subarray(46, 46 + nameLen).toString('utf8');
    const extra = cd.subarray(46 + nameLen, 46 + nameLen + extraLen);
    if (!ENTRY_NAME.test(name)) {
      throw fail(
        'ZIP_ENTRY_NAME',
        'the entry is not named backup_YYYY-MM-DD.sql (it is not the shape MirzaBot writes; the name is not printed).',
      );
    }
    if ((flags & 0x40) !== 0)
      throw fail('ZIP_ENCRYPTION_UNSUPPORTED', 'PKWARE strong encryption is not a MirzaBot shape.');
    let encryption = 'none';
    let actualMethod = method;
    let aesVendorVersion = null;
    if ((flags & 0x01) !== 0) {
      if (method !== 99) {
        throw fail(
          'ZIP_ENCRYPTION_UNSUPPORTED',
          'the entry uses traditional PKWARE (ZipCrypto) encryption; MirzaBot writes WinZip AES-256 only.',
        );
      }
      let aes = null;
      for (let i = 0; i + 4 <= extra.length;) {
        const id = extra.readUInt16LE(i);
        const len = extra.readUInt16LE(i + 2);
        if (id === 0x9901 && len >= 7) aes = extra.subarray(i + 4, i + 4 + len);
        i += 4 + len;
      }
      if (aes === null || aes.subarray(2, 4).toString('latin1') !== 'AE') {
        throw fail('ZIP_ENCRYPTION_UNSUPPORTED', 'method 99 without a WinZip AES extra field.');
      }
      aesVendorVersion = aes.readUInt16LE(0);
      const strength = aes.readUInt8(4);
      actualMethod = aes.readUInt16LE(5);
      if (aesVendorVersion !== 1 && aesVendorVersion !== 2) {
        throw fail(
          'ZIP_ENCRYPTION_UNSUPPORTED',
          `unknown WinZip AES vendor version ${aesVendorVersion}.`,
        );
      }
      if (strength !== 3) {
        throw fail(
          'ZIP_ENCRYPTION_UNSUPPORTED',
          `the entry is AES-${{ 1: 128, 2: 192 }[strength] ?? `?(${strength})`}; MirzaBot writes AES-256 only.`,
        );
      }
      encryption = `AES-256 AE-${aesVendorVersion}`;
    } else if (method === 99) {
      throw fail('ZIP_ENCRYPTION_UNSUPPORTED', 'method 99 on an entry not flagged as encrypted.');
    }
    if (actualMethod !== 0 && actualMethod !== 8) {
      throw fail(
        'ZIP_METHOD_UNSUPPORTED',
        `compression method ${actualMethod} is not stored (0) or deflate (8).`,
      );
    }
    const local = readAt(fd, localOffset, 30);
    if (local.length < 30 || local.readUInt32LE(0) !== 0x04034b50) {
      throw fail('ZIP_TRUNCATED', 'the local file header is missing or damaged.');
    }
    const localName = readAt(fd, localOffset + 30, local.readUInt16LE(26)).toString('utf8');
    if (localName !== name)
      throw fail(
        'ZIP_INCONSISTENT',
        'the local header names a different entry than the central directory.',
      );
    const dataStart = localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
    if (dataStart + compressedSize > size)
      throw fail('ZIP_TRUNCATED', 'the entry runs past the end of the file.');
    return {
      name,
      flags,
      method: actualMethod === 8 ? 'deflate' : 'store',
      encryption,
      aesVendorVersion,
      crc,
      compressedSize,
      uncompressedSize,
      dataStart,
    };
  } finally {
    closeSync(fd);
  }
}

/** WinZip AES key material: PBKDF2-HMAC-SHA1, 1000 rounds, 2×32 + 2 bytes for AES-256. */
export function aesKeys(password, salt) {
  const dk = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, 1000, 66, 'sha1');
  return { encKey: dk.subarray(0, 32), macKey: dk.subarray(32, 64), verifier: dk.subarray(64, 66) };
}

/** AES-256-CTR with WinZip's little-endian counter starting at 1 (Node's CTR is big-endian). */
class WinzipCtr extends Transform {
  constructor(encKey, macKey) {
    super();
    this.ecb = createCipheriv('aes-256-ecb', encKey, null).setAutoPadding(false);
    this.hmac = createHmac('sha1', macKey);
    this.counter = 1n;
    this.pending = Buffer.alloc(0);
    this.keystream = Buffer.alloc(0);
  }

  _transform(chunk, _enc, done) {
    this.hmac.update(chunk);
    const blocks = Math.ceil(Math.max(0, chunk.length - this.keystream.length) / 16);
    if (blocks > 0) {
      const counters = Buffer.alloc(blocks * 16);
      for (let b = 0; b < blocks; b += 1) {
        let c = this.counter;
        for (let i = 0; i < 16; i += 1) {
          counters[b * 16 + i] = Number(c & 0xffn);
          c >>= 8n;
        }
        this.counter += 1n;
      }
      this.keystream = Buffer.concat([this.keystream, this.ecb.update(counters)]);
    }
    const out = Buffer.alloc(chunk.length);
    for (let i = 0; i < chunk.length; i += 1) out[i] = chunk[i] ^ this.keystream[i];
    this.keystream = this.keystream.subarray(chunk.length);
    done(null, out);
  }

  digest() {
    return this.hmac.digest().subarray(0, 10);
  }
}

// --- Inspection ---------------------------------------------------------------------------

function magic(path) {
  const fd = openSync(path, 'r');
  try {
    return readAt(fd, 0, 4);
  } finally {
    closeSync(fd);
  }
}

class Sink extends Writable {
  /**
   * @param {number} limit the most bytes the dump may expand to: the zip's own recorded
   *   size, or `--max-dump-bytes`. Exceeding it aborts at once — before the bytes are
   *   hashed, scanned or written — so a decompression bomb never fills the disk.
   */
  constructor(scanner, file, limit) {
    super();
    this.scanner = scanner;
    this.sha = createHash('sha256');
    this.crc = 0;
    this.file = file;
    this.limit = limit;
    this.written = 0;
    this.fileError = null;
    // A write failure (ENOSPC above all) ends the pipeline through the cleanup path,
    // never as an unhandled 'error' event that kills the process with the file half-written.
    // Settles when the file is closed, whatever happened: the real cause of a write failure
    // (ENOSPC) can arrive after the "stream destroyed" echo that ended the pipeline.
    this.fileClosed = file === null ? Promise.resolve() : new Promise((r) => file.once('close', r));
    if (file !== null) {
      file.on('error', (error) => {
        this.noteFileError(error);
        this.destroy(error);
      });
    }
  }

  /** The first real cause wins over the "stream destroyed" echoes that follow it. */
  noteFileError(error) {
    if (this.fileError === null || this.fileError.code === 'ERR_STREAM_DESTROYED') {
      this.fileError = error;
    }
  }

  _write(chunk, _enc, done) {
    this.written += chunk.length;
    if (this.written > this.limit) {
      return done(
        fail(
          'DECOMPRESSED_SIZE_EXCEEDED',
          `the dump expands past ${this.limit} bytes, more than its container states or --max-dump-bytes allows; stopped before writing it.`,
        ),
      );
    }
    this.sha.update(chunk);
    this.crc = zlib.crc32(chunk, this.crc);
    this.scanner.push(chunk);
    if (this.file === null) return done();
    if (this.file.write(chunk)) return done();
    this.file.once('drain', () => done());
  }

  _final(done) {
    this.scanner.end();
    if (this.file === null) return done();
    // The close can be where a full disk shows first (buffered writes flush here).
    this.file.end((error) => {
      if (error) this.noteFileError(error);
      done(error);
    });
  }
}

async function sha256File(path) {
  const sha = createHash('sha256');
  await pipeline(
    createReadStream(path),
    new Writable({
      write(c, _e, d) {
        sha.update(c);
        d();
      },
    }),
  );
  return sha.digest('hex');
}

export async function inspect(opts) {
  for (const need of ['aes-256-ecb']) {
    if (!getCiphers().includes(need)) {
      throw new Error(
        `this Node build has no ${need} cipher; the inspector needs Node >= 22.11 with OpenSSL.`,
      );
    }
  }
  if (typeof zlib.crc32 !== 'function')
    throw new Error('this Node has no zlib.crc32; the inspector needs Node >= 22.11.');

  const archive = resolve(opts.archive);
  if (!existsSync(archive) || !statSync(archive).isFile())
    throw new Usage(`--archive ${opts.archive} is not a readable file.`);
  const blockers = [];
  const warnings = [];
  const block = (code, detail) => blockers.push({ code, detail });

  let extractPath = null;
  if (opts.out !== null) {
    if (existsSync(opts.out))
      throw new Usage(`--out ${opts.out} already exists; the inspector writes a fresh directory.`);
    mkdirSync(opts.out, { recursive: true, mode: 0o700 });
    chmodSync(opts.out, 0o700);
  }

  const head = magic(archive);
  const container =
    head.length >= 4 && head.readUInt32LE(0) === 0x04034b50
      ? 'zip'
      : head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b
        ? 'gzip'
        : 'plain';
  const lower = basename(archive).toLowerCase();
  const extensionOk =
    (container === 'zip' && lower.endsWith('.zip')) ||
    (container === 'gzip' && lower.endsWith('.sql.gz')) ||
    (container === 'plain' && lower.endsWith('.sql'));
  if (!extensionOk) {
    block(
      'EXTENSION_MISMATCH',
      `the content is ${container} but the file is not named .zip/.sql.gz/.sql to match.`,
    );
  }

  const scanner = new DumpScanner();
  let zip = null;
  let authenticated = null;
  const archiveSha256 = await sha256File(archive);
  let dumpSha256 = null;
  let crcOk = null;

  // The plaintext is written under a TEMPORARY name and takes its final name only after
  // every check of its integrity (HMAC, CRC, size) passed: a reader that finds the final
  // name finds an authenticated dump, never a half-checked one. Any failure unlinks it.
  let partialPath = null;
  let finalPath = null;
  const openOut = (name) => {
    if (!opts.extract) return null;
    finalPath = join(opts.out, name);
    partialPath = join(opts.out, `.${name}.partial`);
    return (opts.openFile ?? ((path) => createWriteStream(path, { flags: 'wx', mode: 0o600 })))(
      partialPath,
    );
  };
  const writeFailed = async (sink, error) => {
    if (sink.fileError !== null) await sink.fileClosed;
    return sink.fileError !== null
      ? fail(
          'EXTRACT_WRITE_FAILED',
          `the extracted dump could not be written: ${sink.fileError.code ?? sink.fileError.message}`,
        )
      : error.blocker !== undefined
        ? error
        : null;
  };

  try {
    if (container === 'zip') {
      if (!ZIP_NAME.test(basename(archive))) {
        warnings.push(
          'the archive is not named backup_YYYY-MM-DD.zip (MirzaBot names it so); its entry decides.',
        );
      }
      zip = readZipEntry(archive);
      const stages = [];
      let ctr = null;
      let storedMac = null;
      let readStart = zip.dataStart;
      let readEnd = zip.dataStart + zip.compressedSize - 1;
      if (zip.encryption !== 'none') {
        if (opts.password === null) {
          throw fail(
            'PASSWORD_REQUIRED',
            'the entry is AES-256 encrypted; pass --password-env NAME.',
          );
        }
        if (zip.compressedSize < 16 + 2 + 10)
          throw fail('ZIP_TRUNCATED', 'the encrypted entry is too short.');
        const fd = openSync(archive, 'r');
        let salt;
        let verifier;
        try {
          salt = readAt(fd, zip.dataStart, 16);
          verifier = readAt(fd, zip.dataStart + 16, 2);
          storedMac = readAt(fd, zip.dataStart + zip.compressedSize - 10, 10);
        } finally {
          closeSync(fd);
        }
        const keys = aesKeys(opts.password, salt);
        if (!timingSafeEqual(keys.verifier, verifier)) {
          throw fail(
            'WRONG_PASSWORD',
            'the password does not open this archive (its verification value differs).',
          );
        }
        ctr = new WinzipCtr(keys.encKey, keys.macKey);
        stages.push(ctr);
        readStart = zip.dataStart + 18;
        readEnd = zip.dataStart + zip.compressedSize - 10 - 1;
      }
      if (zip.method === 'deflate') stages.push(zlib.createInflateRaw());
      const sink = new Sink(scanner, openOut(zip.name), zip.uncompressedSize);
      const source =
        readEnd >= readStart ? createReadStream(archive, { start: readStart, end: readEnd }) : [];
      try {
        await pipeline(source, ...stages, sink);
      } catch (error) {
        const known = await writeFailed(sink, error);
        if (known !== null) throw known;
        if (ctr !== null && !timingSafeEqual(ctr.digest(), storedMac)) {
          throw fail(
            'AUTHENTICATION_FAILED',
            'the encrypted entry does not authenticate (damaged, or the wrong password).',
          );
        }
        throw fail('ZIP_DATA_INVALID', `the entry does not decompress: ${error.message}`);
      }
      if (ctr !== null) {
        authenticated = timingSafeEqual(ctr.digest(), storedMac);
        if (!authenticated) {
          throw fail(
            'AUTHENTICATION_FAILED',
            'the encrypted entry does not authenticate (damaged, or the wrong password).',
          );
        }
      }
      // AE-2 stores no CRC (the HMAC replaces it); AE-1 and unencrypted entries carry one.
      if (zip.aesVendorVersion !== 2) {
        crcOk = sink.crc >>> 0 === zip.crc;
        if (!crcOk) throw fail('ZIP_CRC_MISMATCH', 'the entry CRC-32 does not match its content.');
      }
      if (scanner.bytes !== zip.uncompressedSize) {
        throw fail('ZIP_SIZE_MISMATCH', 'the entry is not the size the central directory records.');
      }
      dumpSha256 = sink.sha.digest('hex');
    } else {
      const stages = container === 'gzip' ? [zlib.createGunzip()] : [];
      const sink = new Sink(
        scanner,
        openOut(
          container === 'gzip' ? basename(archive).replace(/\.gz$/iu, '') : basename(archive),
        ),
        opts.maxDumpBytes ?? DEFAULT_MAX_DUMP_BYTES,
      );
      try {
        await pipeline(createReadStream(archive), ...stages, sink);
      } catch (error) {
        const known = await writeFailed(sink, error);
        if (known !== null) throw known;
        throw fail('GZIP_INVALID', `the gzip stream does not decompress: ${error.message}`);
      }
      dumpSha256 = sink.sha.digest('hex');
    }
    // Every integrity check passed: only now does the plaintext take its final name.
    if (partialPath !== null) {
      renameSync(partialPath, finalPath);
      partialPath = null;
      extractPath = finalPath;
    }
  } catch (error) {
    if (partialPath !== null && existsSync(partialPath)) unlinkSync(partialPath);
    partialPath = null;
    extractPath = null;
    if (error.blocker === undefined) throw error;
    block(error.blocker, error.message);
  }

  let dump = null;
  if (dumpSha256 !== null) {
    const fmt = scanner.format();
    const collations = [...scanner.collations].sort();
    const charsets = [...scanner.charsets].sort();
    const tables = [...scanner.tables.keys()].sort();
    const requiredTables = {};
    for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
      const have = scanner.tables.get(table);
      requiredTables[table] = {
        present: have !== undefined,
        missingColumns: have === undefined ? [...columns] : columns.filter((c) => !have.has(c)),
      };
    }
    const synthetic = fmt?.format === 'synthetic-fixture' || scanner.tables.has(SYNTHETIC_TABLE);
    const engine = sourceEngine(fmt?.serverVersion ?? null, collations);
    dump = {
      sha256: dumpSha256,
      bytes: scanner.bytes,
      format: fmt?.format ?? null,
      synthetic,
      client: fmt?.client ?? null,
      clientVersion: fmt?.clientVersion ?? null,
      distrib: fmt?.distrib ?? null,
      serverVersion: fmt?.serverVersion ?? null,
      engine,
      complete: fmt === null ? null : scanner.complete(fmt.format),
      tables,
      requiredTables,
      insertStatements: Object.fromEntries(
        Object.entries(scanner.insertStatements).sort(([a], [b]) => a.localeCompare(b)),
      ),
      charsets,
      collations,
      requiresMysql8: collations.some((c) => /_0900_/u.test(c)),
      requiresMariadb: collations.some((c) => /_uca1400_/u.test(c)),
      storedObjects: scanner.storedObjects,
      definer: scanner.definer,
      selectsDatabase: [...new Set(scanner.selectsDatabase)],
      createsDatabase: scanner.createsDatabase,
      // Opt-in, so the default report is unchanged: names only, in declaration order.
      ...(opts.columns === true
        ? {
            tableColumns: Object.fromEntries(
              tables.map((table) => [table, [...(scanner.tables.get(table) ?? [])]]),
            ),
          }
        : {}),
    };

    if (fmt === null) {
      block(
        'DUMP_HEADER_UNRECOGNISED',
        "the dump starts with neither a mysqldump/mariadb-dump header nor MirzaBot's PDO-fallback header.",
      );
    }
    if (dump.complete === false) {
      block(
        'DUMP_INCOMPLETE',
        `the ${fmt.format} dump does not end the way its writer ends a dump: it is truncated.`,
      );
    }
    for (const [table, state] of Object.entries(requiredTables)) {
      if (!state.present)
        block('REQUIRED_TABLE_MISSING', `the dump creates no \`${table}\` table.`);
      else if (state.missingColumns.length > 0) {
        block(
          'REQUIRED_COLUMN_MISSING',
          `\`${table}\` lacks ${state.missingColumns.map((c) => `\`${c}\``).join(', ')}.`,
        );
      }
    }
    for (const table of ['user', 'invoice']) {
      if (requiredTables[table].present && (dump.insertStatements[table] ?? 0) === 0) {
        warnings.push(`\`${table}\` has no INSERT statement: the table is empty in this dump.`);
      }
    }
    const objects = Object.keys(dump.storedObjects);
    if (objects.length > 0 || dump.definer) {
      block(
        'STORED_OBJECTS_PRESENT',
        `the dump defines ${objects.join(', ') || 'a DEFINER clause'}; MirzaBot's schema has none, and loading one would run code under another account.`,
      );
    }
    if (dump.selectsDatabase.length > 1) {
      block('MULTIPLE_DATABASES', 'the dump selects more than one database with USE.');
    }
    if (opts.engine === 'mariadb') {
      if (dump.requiresMysql8) {
        block(
          'COLLATION_REQUIRES_MYSQL8',
          `the dump uses ${collations.filter((c) => /_0900_/u.test(c)).join(', ')}, which MariaDB does not have. Load it with --legacy-engine mysql8; never rewrite the collation.`,
        );
      } else if (engine === 'mysql' && (mysqlMajor(dump.serverVersion) ?? 0) >= 8) {
        block(
          'ENGINE_MISMATCH',
          `the dump was taken from MySQL ${dump.serverVersion}; load it with --legacy-engine mysql8.`,
        );
      }
    }
    if (opts.engine === 'mysql8') {
      if (dump.requiresMariadb || engine === 'mariadb') {
        block(
          'ENGINE_MISMATCH',
          'the dump was taken from MariaDB; load it with --legacy-engine mariadb.',
        );
      }
    }
    if (opts.requireClass === 'staging' && synthetic) {
      block(
        'SYNTHETIC_AS_STAGING',
        'the dump is the SYNTHETIC fixture; a run on it is never staging evidence.',
      );
    }
    if (opts.requireClass === 'synthetic' && !synthetic) {
      block(
        'NOT_SYNTHETIC',
        'a synthetic run needs the synthetic fixture; this dump does not carry its marker.',
      );
    }
  }

  const report = {
    schema: SCHEMA,
    archive: {
      name: basename(archive),
      bytes: statSync(archive).size,
      sha256: archiveSha256,
      container,
    },
    zip:
      zip === null
        ? null
        : {
            entry: zip.name,
            method: zip.method,
            encryption: zip.encryption,
            authenticated,
            crcChecked: crcOk,
            compressedBytes: zip.compressedSize,
            uncompressedBytes: zip.uncompressedSize,
          },
    dump,
    engineChecked: opts.engine,
    requiredClass: opts.requireClass,
    extracted: extractPath === null || blockers.length > 0 ? null : extractPath,
    blockers,
    warnings,
    verdict: blockers.length === 0 ? 'ACCEPTED' : 'BLOCKED',
  };
  // A blocked archive leaves no extracted copy behind: nothing downstream may load it.
  if (blockers.length > 0 && extractPath !== null && existsSync(extractPath))
    unlinkSync(extractPath);
  if (opts.out !== null) {
    writeFileSync(join(opts.out, 'archive.json'), `${JSON.stringify(report, null, 2)}\n`, {
      mode: 0o600,
    });
  }
  return report;
}

// --- Main ---------------------------------------------------------------------------------

const HELP = `usage: node scripts/legacy-archive-inspect.mjs --archive PATH
         [--password-env NAME] [--engine mariadb|mysql8] [--out DIR [--extract]]
         [--require-class synthetic|staging] [--max-dump-bytes N] [--columns]
The password is read ONLY from the environment variable NAME; never pass it on argv.`;

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2), process.env);
  } catch (error) {
    if (error instanceof Usage) {
      process.stderr.write(
        error.message === 'help'
          ? `${HELP}\n`
          : `legacy-archive-inspect: ${error.message}\n${HELP}\n`,
      );
      process.exit(error.message === 'help' ? 0 : 64);
    }
    throw error;
  }
  try {
    const report = await inspect(opts);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exit(report.verdict === 'ACCEPTED' ? 0 : 2);
  } catch (error) {
    if (error instanceof Usage) {
      process.stderr.write(`legacy-archive-inspect: ${error.message}\n`);
      process.exit(64);
    }
    process.stderr.write(`legacy-archive-inspect: ${error.message}\n`);
    process.exit(1);
  }
}
