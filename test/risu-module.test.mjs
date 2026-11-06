import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
    decodeRisum, readCharxMember, readModuleFromCharx, RisuModuleError, MAX_MODULE_JSON, MAX_MODULE_FILE,
} from '../server/risu-module.js';

const ENCODE = (await fs.readFile(new URL('../server/rpack-map.bin', import.meta.url))).subarray(0, 256);

function pack(bytes) {
    return Uint8Array.from(bytes, b => ENCODE[b]);
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

const SAMPLE = {
    name: 'Sample',
    regex: [{ comment: 'a', in: 'x', out: 'y', type: 'editoutput' }],
    trigger: [],
    lorebook: [{ key: 'k', content: 'c' }],
};

test('round trip keeps the module and counts assets', () => {
    const r = decodeRisum(encodeRisum(SAMPLE, { assets: [Buffer.from('abc'), Buffer.from([0, 255, 7])] }));
    assert.deepEqual(r.module, SAMPLE);
    assert.equal(r.assetCount, 2);
    assert.equal(decodeRisum(encodeRisum(SAMPLE)).assetCount, 0);
});

test('a decoded __proto__ key stays data', () => {
    const bytes = encodeRisum(JSON.parse('{"__proto__":{"polluted":true},"name":"p"}'));
    const r = decodeRisum(bytes);
    assert.equal(({}).polluted, undefined);
    assert.equal(r.module.name, 'p');
});

test('decodeRisum refuses bad input with RisuModuleError', () => {
    const good = encodeRisum(SAMPLE, { assets: [Buffer.from('abc')] });
    const bad = (bytes, re) => assert.throws(() => decodeRisum(bytes), (e) => e instanceof RisuModuleError && re.test(e.message));
    bad(new Uint8Array(3), /too short/);
    bad(Buffer.concat([Buffer.from([112]), good.subarray(1)]), /magic/);
    bad(Buffer.concat([Buffer.from([111, 1]), good.subarray(2)]), /version 1/);
    bad(good.subarray(0, 20), /truncated inside its JSON/);
    const huge = Buffer.from(good);
    huge.writeUInt32LE(MAX_MODULE_JSON + 1, 2);
    bad(huge, /cap/);
    const notJson = Buffer.concat([Buffer.from([111, 0]), u32(4), pack(Buffer.from('nope'))]);
    bad(notJson, /not readable/);
    bad(encodeRisum(SAMPLE, { type: 'other' }), /not a risuModule/);
    bad(encodeRisum(SAMPLE, { tail: false }), /final mark/);
    bad(good.subarray(0, good.length - 3), /truncated inside an asset/);
    const lying = Buffer.from(good);
    lying.writeUInt32LE(0xFFFFFFF0, 6 + good.readUInt32LE(2) + 1);
    bad(lying, /truncated inside an asset/);
    bad(Buffer.concat([good.subarray(0, good.length - 1), Buffer.from([9])]), /unknown asset mark/);
});

// ---- a zip writer for the tests
function crc(buf) {
    return zlib.crc32(buf);
}

function buildZip(members, { zip64 = false, badCrc = false, comment = '' } = {}) {
    const parts = [];
    const central = [];
    let offset = 0;
    for (const m of members) {
        const name = Buffer.from(m.name);
        const raw = Buffer.from(m.data);
        const body = m.stored ? raw : zlib.deflateRawSync(raw);
        const c = badCrc ? 1234 : crc(raw);
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

// a JPEG-ish prefix, as a RisuAI download may carry
const JPEG = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(3000, 0x41), Buffer.from([0xFF, 0xD9])]);

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'risu-module-'));
test.after(() => fs.rm(dir, { recursive: true, force: true }));

async function put(name, buf) {
    const file = path.join(dir, name);
    await fs.writeFile(file, buf);
    return file;
}

const MODULE_BYTES = encodeRisum(SAMPLE, { assets: [Buffer.from('img')] });

test('charx with a JPEG prefix: stored and deflate members', async () => {
    for (const stored of [true, false]) {
        const zip = buildZip([
            { name: 'card.json', data: '{"a":1}', stored: !stored },
            { name: 'module.risum', data: MODULE_BYTES, stored },
        ], { comment: 'hello' });
        const file = await put(`prefixed-${stored}.charx`, Buffer.concat([JPEG, zip]));
        assert.deepEqual(await readCharxMember(file, 'card.json'), Buffer.from('{"a":1}'));
        const r = await readModuleFromCharx(file);
        assert.deepEqual(r.module, SAMPLE);
        assert.equal(r.assetCount, 1);
    }
});

test('a plain zip without a prefix reads too', async () => {
    const file = await put('plain.charx', buildZip([{ name: 'module.risum', data: MODULE_BYTES }]));
    assert.equal((await readModuleFromCharx(file)).assetCount, 1);
});

test('missing member, not a zip, a PNG-like file, no file', async () => {
    const file = await put('nomod.charx', buildZip([{ name: 'card.json', data: '{}' }]));
    assert.equal(await readCharxMember(file, 'module.risum'), null);
    assert.equal(await readCharxMember(file, 'Module.risum'), null);
    assert.equal(await readModuleFromCharx(file), null);
    assert.equal(await readModuleFromCharx(await put('junk.bin', Buffer.from('not a zip at all, not even close'))), null);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(5000, 7)]);
    assert.equal(await readModuleFromCharx(await put('card.png', png)), null);
    assert.equal(await readModuleFromCharx(path.join(dir, 'absent')), null);
});

test('a bomb stops at max, and a lying size is caught', async () => {
    const bomb = Buffer.alloc(5 * 1024 * 1024, 0);
    const file = await put('bomb.zip', buildZip([{ name: 'big', data: bomb }]));
    await assert.rejects(readCharxMember(file, 'big', { max: 1024 }), RisuModuleError);
    assert.equal((await readCharxMember(file, 'big', { max: bomb.length })).length, bomb.length);

    // central directory claims 10 bytes but the stream inflates to far more
    const zip = Buffer.from(buildZip([{ name: 'big', data: bomb }]));
    const cen = zip.indexOf(Buffer.from([0x50, 0x4B, 0x01, 0x02]));
    zip.writeUInt32LE(10, cen + 24);
    await assert.rejects(readCharxMember(await put('lie.zip', zip), 'big'), /larger than it says/);
});

test('bad checksum and a member running past the file are errors', async () => {
    const bad = await put('crc.zip', buildZip([{ name: 'm', data: 'hello', stored: true }], { badCrc: true }));
    await assert.rejects(readCharxMember(bad, 'm'), /checksum/);
    const zip = Buffer.from(buildZip([{ name: 'm', data: 'hello world', stored: true }]));
    const cen = zip.indexOf(Buffer.from([0x50, 0x4B, 0x01, 0x02]));
    zip.writeUInt32LE(0x7FFFFFF0, cen + 20);
    await assert.rejects(readCharxMember(await put('past.zip', zip), 'm'), /past the end/);
});

test('a corrupt module in a good charx throws RisuModuleError', async () => {
    const file = await put('corrupt.charx', buildZip([{ name: 'module.risum', data: Buffer.from('not a risum at all') }]));
    await assert.rejects(readModuleFromCharx(file), RisuModuleError);
});

test('zip64 records read, even behind a prefix', async () => {
    const zip = buildZip([{ name: 'module.risum', data: MODULE_BYTES }], { zip64: true });
    const file = await put('zip64.charx', Buffer.concat([JPEG, zip]));
    assert.equal((await readModuleFromCharx(file)).assetCount, 1);
});

test('a member past 4 GiB in the file (zip behind a sparse prefix)', async (t) => {
    const prefix = 5 * 1024 ** 3;
    const file = path.join(dir, 'big-offset.charx');
    let fh;
    try {
        fh = await fs.open(file, 'w');
        await fh.write(JPEG, 0, JPEG.length, 0);
        for (const zip64 of [false, true]) {
            const zip = buildZip([{ name: 'module.risum', data: MODULE_BYTES }], { zip64 });
            await fh.truncate(prefix);
            await fh.write(zip, 0, zip.length, prefix);
            assert.equal((await readModuleFromCharx(file)).assetCount, 1);
            await fh.truncate(0);
            await fh.write(JPEG, 0, JPEG.length, 0);
        }
    } catch (e) {
        if (e instanceof assert.AssertionError || e instanceof RisuModuleError) throw e;
        t.skip(`no sparse file here: ${e.code || e.message}`);
    } finally {
        await fh?.close();
        await fs.rm(file, { force: true });
    }
});

test('the module caps are at most 64 MB, and a module.risum over the file cap is refused unread', async () => {
    assert.ok(MAX_MODULE_FILE <= 64 * 1024 * 1024);
    assert.ok(MAX_MODULE_JSON <= MAX_MODULE_FILE);
    const big = buildZip([{ name: 'card.json', data: '{}' }, { name: 'module.risum', data: Buffer.alloc(MAX_MODULE_FILE + 1) }]);
    const file = await put('over-cap.charx', big);
    await assert.rejects(() => readModuleFromCharx(file), (e) => e instanceof RisuModuleError && /byte limit/.test(e.message));
});
