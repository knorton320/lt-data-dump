/**
 * lib/zip.js — Minimal ZIP archive creator (STORE mode, no compression).
 *
 * Creates valid ZIP archives readable by any standard unzip tool.
 * Uses STORE (method=0, no compression) — fast and sufficient for the
 * JSON text files produced by the Firestore dump.
 *
 * API:
 *   createZip(files) → Uint8Array
 *     files: { [filename: string]: Uint8Array }
 *     Returns a Uint8Array containing a valid ZIP file.
 */

"use strict";

// ─── CRC-32 (IEEE 802.3 polynomial) ─────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(data) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = (CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ─── Binary helpers ──────────────────────────────────────────────────────────

function u16le(view, offset, value) {
  view.setUint16(offset, value, /* littleEndian */ true);
}

function u32le(view, offset, value) {
  view.setUint32(offset, value, /* littleEndian */ true);
}

function concat(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

function encodeFilename(name) {
  // All filenames produced by the dump are ASCII — avoid TextEncoder dependency.
  const bytes = new Uint8Array(name.length);
  for (let i = 0; i < name.length; i++) {
    bytes[i] = name.charCodeAt(i) & 0x7f;
  }
  return bytes;
}

// ─── ZIP structure builders ──────────────────────────────────────────────────

function localFileHeader(nameBytes, size, crc) {
  const hdr = new Uint8Array(30 + nameBytes.length);
  const v = new DataView(hdr.buffer);
  u32le(v, 0,  0x04034b50); // Local file header signature
  u16le(v, 4,  20);          // Version needed (2.0)
  u16le(v, 6,  0);           // General purpose bit flag
  u16le(v, 8,  0);           // Compression method: STORE
  u16le(v, 10, 0);           // Last mod file time
  u16le(v, 12, 0);           // Last mod file date
  u32le(v, 14, crc);         // CRC-32
  u32le(v, 18, size);        // Compressed size
  u32le(v, 22, size);        // Uncompressed size
  u16le(v, 26, nameBytes.length); // File name length
  u16le(v, 28, 0);           // Extra field length
  hdr.set(nameBytes, 30);
  return hdr;
}

function centralDirHeader(nameBytes, size, crc, localOffset) {
  const hdr = new Uint8Array(46 + nameBytes.length);
  const v = new DataView(hdr.buffer);
  u32le(v, 0,  0x02014b50); // Central directory file header signature
  u16le(v, 4,  20);          // Version made by
  u16le(v, 6,  20);          // Version needed
  u16le(v, 8,  0);           // General purpose bit flag
  u16le(v, 10, 0);           // Compression method: STORE
  u16le(v, 12, 0);           // Last mod file time
  u16le(v, 14, 0);           // Last mod file date
  u32le(v, 16, crc);         // CRC-32
  u32le(v, 20, size);        // Compressed size
  u32le(v, 24, size);        // Uncompressed size
  u16le(v, 28, nameBytes.length); // File name length
  u16le(v, 30, 0);           // Extra field length
  u16le(v, 32, 0);           // File comment length
  u16le(v, 34, 0);           // Disk number start
  u16le(v, 36, 0);           // Internal file attributes
  u32le(v, 38, 0);           // External file attributes
  u32le(v, 42, localOffset); // Relative offset of local header
  hdr.set(nameBytes, 46);
  return hdr;
}

function endOfCentralDirectory(entryCount, centralDirSize, centralDirOffset) {
  const eocd = new Uint8Array(22);
  const v = new DataView(eocd.buffer);
  u32le(v, 0,  0x06054b50); // End of central directory signature
  u16le(v, 4,  0);           // Number of this disk
  u16le(v, 6,  0);           // Disk where central directory starts
  u16le(v, 8,  entryCount);  // Number of central directory records on this disk
  u16le(v, 10, entryCount);  // Total number of central directory records
  u32le(v, 12, centralDirSize);    // Size of central directory
  u32le(v, 16, centralDirOffset);  // Offset of central directory
  u16le(v, 20, 0);           // Comment length
  return eocd;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Build a ZIP archive from a map of files.
 *
 * @param {Object.<string, Uint8Array>} files  filename → byte content
 * @returns {Uint8Array}  ZIP file bytes
 */
export function createZip(files) {
  const entries = [];
  let localOffset = 0;

  for (const [name, data] of Object.entries(files)) {
    const nameBytes = encodeFilename(name);
    const chk = crc32(data);
    const hdr = localFileHeader(nameBytes, data.length, chk);
    entries.push({ nameBytes, data, crc: chk, size: data.length, hdr, localOffset });
    localOffset += hdr.length + data.length;
  }

  const centralDirOffset = localOffset;
  const centralParts = entries.map(({ nameBytes, crc, size, localOffset: off }) =>
    centralDirHeader(nameBytes, size, crc, off)
  );
  const centralDirSize = centralParts.reduce((s, p) => s + p.length, 0);
  const eocd = endOfCentralDirectory(entries.length, centralDirSize, centralDirOffset);

  return concat([
    ...entries.flatMap(({ hdr, data }) => [hdr, data]),
    ...centralParts,
    eocd,
  ]);
}
