// Reads the module a RisuAI charx carries (module.risum): regex, triggers and lorebook live only
// there. The bytes are a stranger's, so nothing here evaluates them and every length is checked.
import fs from 'node:fs/promises';
import zlib from 'node:zlib';

export class RisuModuleError extends Error {
    constructor(message) {
        super(message);
        this.name = 'RisuModuleError';
    }
}

// a pretty-printed module with a big lorebook is a few MB; these only stop a lying length. The whole
// module.risum is read into memory (on a phone), so the file cap is the memory bound; the JSON inside
// it can be no larger than the file.
export const MAX_MODULE_FILE = 64 * 1024 * 1024;
export const MAX_MODULE_JSON = MAX_MODULE_FILE;

// the central directory is read whole, so it gets a cap too
const MAX_CENTRAL_DIRECTORY = 64 * 1024 * 1024;

// rpack: bytes 256-511 of the map are the decode half; loaded once
const DECODE = new Uint8Array(await fs.readFile(new URL('./rpack-map.bin', import.meta.url))).subarray(256, 512);
if (DECODE.length !== 256) throw new Error('rpack-map.bin must hold 512 bytes');

function unpack(bytes) {
    const out = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) out[i] = DECODE[bytes[i]];
    return out;
}

/**
 * Decode a legacy .risum: the JSON block, and a count of the asset blobs (not decoded).
 * @param {Uint8Array} bytes
 * @returns {{ module: object, assetCount: number }}
 */
export function decodeRisum(bytes) {
    if (!(bytes instanceof Uint8Array)) throw new RisuModuleError('module is not a byte array');
    if (bytes.length < 6) throw new RisuModuleError('module is too short to hold a header');
    if (bytes[0] !== 111) throw new RisuModuleError('module has the wrong magic byte (not a .risum)');
    if (bytes[1] !== 0) throw new RisuModuleError(`module version ${bytes[1]} is not supported`);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const jsonLength = view.getUint32(2, true);
    if (jsonLength > MAX_MODULE_JSON) throw new RisuModuleError(`module JSON of ${jsonLength} bytes is over the ${MAX_MODULE_JSON} byte cap`);
    if (6 + jsonLength > bytes.length) throw new RisuModuleError('module is truncated inside its JSON block');

    let parsed;
    try {
        parsed = JSON.parse(Buffer.from(unpack(bytes.subarray(6, 6 + jsonLength))).toString('utf8'));
    } catch (e) {
        throw new RisuModuleError(`module JSON is not readable: ${e.message}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.type !== 'risuModule') {
        throw new RisuModuleError('module JSON is not a risuModule');
    }
    if (!parsed.module || typeof parsed.module !== 'object' || Array.isArray(parsed.module)) {
        throw new RisuModuleError('module JSON has no module object');
    }

    // asset blobs are only walked: a mark, a length, the blob; a mark of 0 ends the file
    let pos = 6 + jsonLength;
    let assetCount = 0;
    for (;;) {
        if (pos >= bytes.length) throw new RisuModuleError('module is truncated: the final mark is missing');
        const mark = bytes[pos++];
        if (mark === 0) break;
        if (mark !== 1) throw new RisuModuleError(`module has an unknown asset mark ${mark}`);
        if (pos + 4 > bytes.length) throw new RisuModuleError('module is truncated inside an asset length');
        const length = view.getUint32(pos, true);
        pos += 4;
        if (pos + length > bytes.length) throw new RisuModuleError('module is truncated inside an asset');
        pos += length;
        assetCount++;
    }
    return { module: parsed.module, assetCount };
}

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_LOCATOR64 = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

function safeNumber(big, what) {
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new RisuModuleError(`zip ${what} is out of range`);
    return Number(big);
}

async function readAt(fh, position, length) {
    const buf = Buffer.alloc(length);
    let got = 0;
    while (got < length) {
        const { bytesRead } = await fh.read(buf, got, length - got, position + got);
        if (!bytesRead) break;
        got += bytesRead;
    }
    return got === length ? buf : buf.subarray(0, got);
}

// where the central directory is, and how far the zip is shifted by a prefix (a JPEG ahead of it)
async function findDirectory(fh, size) {
    const tailLength = Math.min(size, 22 + 0xFFFF);
    const tailStart = size - tailLength;
    const tail = await readAt(fh, tailStart, tailLength);
    let at = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
        if (tail.readUInt32LE(i) !== SIG_EOCD) continue;
        // the comment must fit the file, or this is a signature inside someone's data
        if (i + 22 + tail.readUInt16LE(i + 20) > tail.length) continue;
        at = i;
        break;
    }
    if (at < 0) return null;
    const eocdPos = tailStart + at;
    let cdSize = tail.readUInt32LE(at + 12);
    let cdOffset = tail.readUInt32LE(at + 16);
    let endOfDirectory = eocdPos;

    if (tail.readUInt16LE(at + 10) === 0xFFFF || cdSize === 0xFFFFFFFF || cdOffset === 0xFFFFFFFF) {
        const locatorPos = eocdPos - 20;
        const locator = locatorPos >= 0 ? await readAt(fh, locatorPos, 20) : Buffer.alloc(0);
        if (locator.length < 20 || locator.readUInt32LE(0) !== SIG_LOCATOR64) {
            throw new RisuModuleError('zip64 end record is missing');
        }
        const recordOffset = safeNumber(locator.readBigUInt64LE(8), 'offset');
        // the record sits right before its locator; the prefix is whatever offset is left over
        const recordPos = locatorPos - 56;
        const record = recordPos >= 0 ? await readAt(fh, recordPos, 56) : Buffer.alloc(0);
        if (record.length < 56 || record.readUInt32LE(0) !== SIG_EOCD64 || recordPos < recordOffset) {
            throw new RisuModuleError('zip64 end record is damaged');
        }
        cdSize = safeNumber(record.readBigUInt64LE(40), 'directory size');
        cdOffset = safeNumber(record.readBigUInt64LE(48), 'directory offset');
        endOfDirectory = recordPos;
    }
    const shift = endOfDirectory - (cdOffset + cdSize);
    if (shift < 0) throw new RisuModuleError('zip central directory is out of range');
    return { cdSize, cdStart: cdOffset + shift, shift };
}

function parseEntry(cd, pos) {
    const flags = cd.readUInt16LE(pos + 8);
    const method = cd.readUInt16LE(pos + 10);
    const crc = cd.readUInt32LE(pos + 16);
    let compSize = cd.readUInt32LE(pos + 20);
    let size = cd.readUInt32LE(pos + 24);
    const nameLength = cd.readUInt16LE(pos + 28);
    const extraLength = cd.readUInt16LE(pos + 30);
    const commentLength = cd.readUInt16LE(pos + 32);
    let offset = cd.readUInt32LE(pos + 42);
    const next = pos + 46 + nameLength + extraLength + commentLength;
    if (next > cd.length) throw new RisuModuleError('zip central directory is damaged');
    const name = cd.toString('utf8', pos + 46, pos + 46 + nameLength);

    // zip64 extra field: only the fields that read 0xFFFFFFFF are present, in this order
    if (size === 0xFFFFFFFF || compSize === 0xFFFFFFFF || offset === 0xFFFFFFFF) {
        let x = pos + 46 + nameLength;
        const xEnd = x + extraLength;
        while (x + 4 <= xEnd) {
            const id = cd.readUInt16LE(x);
            const length = cd.readUInt16LE(x + 2);
            if (id === 1) {
                let p = x + 4;
                const take = () => {
                    if (p + 8 > x + 4 + length) throw new RisuModuleError('zip64 extra field is damaged');
                    const value = safeNumber(cd.readBigUInt64LE(p), 'size');
                    p += 8;
                    return value;
                };
                if (size === 0xFFFFFFFF) size = take();
                if (compSize === 0xFFFFFFFF) compSize = take();
                if (offset === 0xFFFFFFFF) offset = take();
                break;
            }
            x += 4 + length;
        }
        if (size === 0xFFFFFFFF || compSize === 0xFFFFFFFF || offset === 0xFFFFFFFF) {
            throw new RisuModuleError('zip64 extra field is missing');
        }
    }
    return { entry: { name, flags, method, crc, compSize, size, offset }, next };
}

function crcUpdate(crc, chunk) {
    if (typeof zlib.crc32 === 'function') return zlib.crc32(chunk, crc);
    let c = ~crc;
    for (let i = 0; i < chunk.length; i++) {
        c ^= chunk[i];
        for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
    }
    return ~c >>> 0;
}

async function extract(fh, size, entry, shift, max) {
    if (entry.flags & 1) throw new RisuModuleError(`zip member ${entry.name} is encrypted`);
    if (entry.method !== 0 && entry.method !== 8) throw new RisuModuleError(`zip member ${entry.name} uses unsupported method ${entry.method}`);
    // the declared size is a lie until the bytes agree, but a big claim is refused before reading
    if (entry.size > max) throw new RisuModuleError(`zip member ${entry.name} is over the ${max} byte limit`);
    const local = entry.offset + shift;
    const header = await readAt(fh, local, 30);
    if (header.length < 30 || header.readUInt32LE(0) !== SIG_LOCAL) throw new RisuModuleError(`zip member ${entry.name} has no local header`);
    const start = local + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    if (start + entry.compSize > size) throw new RisuModuleError(`zip member ${entry.name} runs past the end of the file`);

    let total = 0;
    let crc = 0;
    const chunks = [];
    const take = (chunk) => {
        total += chunk.length;
        if (total > max || total > entry.size) {
            throw new RisuModuleError(`zip member ${entry.name} is larger than it says or over the ${max} byte limit`);
        }
        crc = crcUpdate(crc, chunk);
        chunks.push(chunk);
    };
    if (entry.compSize > 0) {
        const source = fh.createReadStream({ start, end: start + entry.compSize - 1, autoClose: false });
        if (entry.method === 0) {
            try { for await (const chunk of source) take(chunk); }
            finally { source.destroy(); }
        } else {
            const inflate = zlib.createInflateRaw();
            source.on('error', e => inflate.destroy(e));
            source.pipe(inflate);
            try { for await (const chunk of inflate) take(chunk); }
            catch (e) {
                if (e instanceof RisuModuleError) throw e;
                throw new RisuModuleError(`zip member ${entry.name} does not inflate: ${e.message}`);
            } finally { source.destroy(); inflate.destroy(); }
        }
    }
    if (total !== entry.size) throw new RisuModuleError(`zip member ${entry.name} is ${total} bytes, not the ${entry.size} it says`);
    if (crc !== entry.crc) throw new RisuModuleError(`zip member ${entry.name} fails its checksum`);
    return Buffer.concat(chunks, total);
}

/**
 * One member of a zip on disk, without reading the rest. Null when the file is no zip or lacks
 * the member; a zip that is damaged, too big or unsupported throws RisuModuleError.
 * @param {string} filePath
 * @param {string} name exact member name
 * @param {{ max?: number }} [opts] cap on the uncompressed size
 * @returns {Promise<Buffer | null>}
 */
export async function readCharxMember(filePath, name, opts = {}) {
    const max = opts.max ?? MAX_MODULE_FILE;
    let fh;
    try { fh = await fs.open(filePath, 'r'); } catch (e) {
        if (e.code === 'ENOENT' || e.code === 'EISDIR') return null;
        throw e;
    }
    try {
        const { size } = await fh.stat();
        if (size < 22) return null;
        const dir = await findDirectory(fh, size);
        if (!dir) return null;
        if (dir.cdSize > MAX_CENTRAL_DIRECTORY) throw new RisuModuleError('zip central directory is too large');
        const cd = await readAt(fh, dir.cdStart, dir.cdSize);
        if (cd.length !== dir.cdSize) throw new RisuModuleError('zip central directory is truncated');
        let pos = 0;
        while (pos + 46 <= cd.length) {
            if (cd.readUInt32LE(pos) !== SIG_CENTRAL) throw new RisuModuleError('zip central directory is damaged');
            const { entry, next } = parseEntry(cd, pos);
            if (entry.name === name) return await extract(fh, size, entry, dir.shift, max);
            pos = next;
        }
        return null;
    } finally {
        await fh.close();
    }
}

/**
 * The module of a charx: regex, trigger and lorebook. Null for a file without one (a PNG card,
 * a plain charx); a module that will not decode throws RisuModuleError.
 * @param {string} filePath
 * @returns {Promise<{ module: object, assetCount: number } | null>}
 */
export async function readModuleFromCharx(filePath) {
    const bytes = await readCharxMember(filePath, 'module.risum', { max: MAX_MODULE_FILE });
    return bytes ? decodeRisum(bytes) : null;
}
