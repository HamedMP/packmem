import * as zlib from "node:zlib";

// node:zlib gained zstd in Node 22.15 and 23.8; Brotli is there on every supported Node.
const ZSTD_LEVEL = zlib.constants.ZSTD_c_compressionLevel ?? 100;

export function zstdAvailable() {
  return typeof zlib.zstdCompressSync === "function" && typeof zlib.createZstdCompress === "function";
}

export function defaultCodec() {
  return zstdAvailable() ? "zstd" : "brotli";
}

export function assertCodec(codec) {
  if (codec === "zstd" && !zstdAvailable()) throw new Error("This archive uses zstd, which needs Node 22.15 or newer.");
  if (codec !== "zstd" && codec !== "brotli") throw new Error(`Unknown archive codec ${JSON.stringify(codec)}.`);
}

const zstdOpts = (level) => ({ params: { [ZSTD_LEVEL]: level ?? 19 } });
function brotliOpts(level, sizeHint) {
  const params = { [zlib.constants.BROTLI_PARAM_QUALITY]: level ?? 9, [zlib.constants.BROTLI_PARAM_LGWIN]: 24 };
  if (sizeHint !== undefined) params[zlib.constants.BROTLI_PARAM_SIZE_HINT] = sizeHint;
  return { params };
}

export function compressSync(codec, data, level) {
  assertCodec(codec);
  return codec === "zstd" ? zlib.zstdCompressSync(data, zstdOpts(level)) : zlib.brotliCompressSync(data, brotliOpts(level, data.length));
}

/** Refuses to inflate past `maxBytes`, so a damaged or planted frame cannot exhaust memory. */
export function decompressSync(codec, data, maxBytes) {
  assertCodec(codec);
  const opts = { maxOutputLength: Math.max(1, maxBytes) };
  return codec === "zstd" ? zlib.zstdDecompressSync(data, opts) : zlib.brotliDecompressSync(data, opts);
}

export function createCompress(codec, level) {
  assertCodec(codec);
  return codec === "zstd" ? zlib.createZstdCompress(zstdOpts(level)) : zlib.createBrotliCompress(brotliOpts(level));
}

export function createDecompress(codec) {
  assertCodec(codec);
  return codec === "zstd" ? zlib.createZstdDecompress() : zlib.createBrotliDecompress();
}
