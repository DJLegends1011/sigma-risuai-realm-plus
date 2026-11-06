// Builders for the integration test: a charx (zip) holding a card, a Risu module and assets, and a PNG card.
import fs from 'node:fs/promises';
import zlib from 'node:zlib';

const ENCODE = (await fs.readFile(new URL('../../server/rpack-map.bin', import.meta.url))).subarray(0, 256);

function pack(bytes) {
    // a plain loop: Uint8Array.from took seconds on big fixtures, long enough for the kit server's
    // keep-alive to close the idle socket under the test's next request
    const out = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) out[i] = ENCODE[bytes[i]];
    return out;
}

function u32(n) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
}

// a test-only encoder: magic, version, rpack JSON, then blobs and the final mark
function encodeRisum(module, { assets = [], type = 'risuModule', tail = true } = {}) {
    const json = pack(Buffer.from(JSON.stringify({ type, module })));
    const parts = [Buffer.from([111, 0]), u32(json.length), json];
    for (const a of assets) {
        const blob = pack(a);
        parts.push(Buffer.from([1]), u32(blob.length), blob);
    }
    if (tail) parts.push(Buffer.from([0]));
    return Buffer.concat(parts);
}

export const encodeRisumModule = encodeRisum;

function buildZipImpl(members, { zip64 = false, badCrc = false, comment = '' } = {}) {
    const parts = [];
    const central = [];
    let offset = 0;
    for (const m of members) {
        const name = Buffer.from(m.name);
        const raw = Buffer.from(m.data);
        const body = m.stored ? raw : zlib.deflateRawSync(raw);
        const c = badCrc ? 1234 : zlib.crc32(raw);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(m.stored ? 0 : 8, 8);
        local.writeUInt32LE(c, 14);
        local.writeUInt32LE(body.length, 18);
        local.writeUInt32LE(raw.length, 22);
        local.writeUInt16LE(name.length, 26);
        parts.push(local, name, body);
        const extra = zip64 ? Buffer.alloc(28) : Buffer.alloc(0);
        if (zip64) {
            extra.writeUInt16LE(1, 0);
            extra.writeUInt16LE(24, 2);
            extra.writeBigUInt64LE(BigInt(raw.length), 4);
            extra.writeBigUInt64LE(BigInt(body.length), 12);
            extra.writeBigUInt64LE(BigInt(offset), 20);
        }
        const cen = Buffer.alloc(46);
        cen.writeUInt32LE(0x02014b50, 0);
        cen.writeUInt16LE(20, 4);
        cen.writeUInt16LE(20, 6);
        cen.writeUInt16LE(m.stored ? 0 : 8, 10);
        cen.writeUInt32LE(c, 16);
        cen.writeUInt32LE(zip64 ? 0xFFFFFFFF : body.length, 20);
        cen.writeUInt32LE(zip64 ? 0xFFFFFFFF : raw.length, 24);
        cen.writeUInt16LE(name.length, 28);
        cen.writeUInt16LE(extra.length, 30);
        cen.writeUInt32LE(zip64 ? 0xFFFFFFFF : offset, 42);
        central.push(cen, name, extra);
        offset += 30 + name.length + body.length;
    }
    const cd = Buffer.concat(central);
    const cdOffset = offset;
    const cm = Buffer.from(comment);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(zip64 ? 0xFFFF : members.length, 8);
    eocd.writeUInt16LE(zip64 ? 0xFFFF : members.length, 10);
    eocd.writeUInt32LE(zip64 ? 0xFFFFFFFF : cd.length, 12);
    eocd.writeUInt32LE(zip64 ? 0xFFFFFFFF : cdOffset, 16);
    eocd.writeUInt16LE(cm.length, 20);
    const out = [...parts, cd];
    if (zip64) {
        const rec = Buffer.alloc(56);
        rec.writeUInt32LE(0x06064b50, 0);
        rec.writeBigUInt64LE(44n, 4);
        rec.writeBigUInt64LE(BigInt(members.length), 24);
        rec.writeBigUInt64LE(BigInt(members.length), 32);
        rec.writeBigUInt64LE(BigInt(cd.length), 40);
        rec.writeBigUInt64LE(BigInt(cdOffset), 48);
        const loc = Buffer.alloc(20);
        loc.writeUInt32LE(0x07064b50, 0);
        loc.writeBigUInt64LE(BigInt(cdOffset + cd.length), 8);
        loc.writeUInt32LE(1, 16);
        out.push(rec, loc);
    }
    out.push(eocd, cm);
    return Buffer.concat(out);
}


export const buildZip = buildZipImpl;

// a PNG card: the base png with a "chara" text chunk (base64 JSON) ahead of IEND
export function pngWithCard(basePng, card) {
    const type = Buffer.from('tEXt', 'latin1');
    const data = Buffer.concat([Buffer.from('chara\0', 'latin1'), Buffer.from(Buffer.from(JSON.stringify(card)).toString('base64'), 'latin1')]);
    const head = Buffer.alloc(4); head.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([type, data])));
    const iend = basePng.length - 12;
    return Buffer.concat([basePng.subarray(0, iend), head, type, data, crc, basePng.subarray(iend)]);
}
