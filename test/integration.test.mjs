// The extension end to end on a real Σ (the extension kit: the server in this process on a temporary home), with
// accounts. The Realm is a stand-in answering the download URL; the shipped client/realm-provider.js runs
// against the real server, its /modules imports answered by stand-ins (test/helpers).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(__dirname, '..');
const KIT = [
    path.resolve(__dirname, '../../../../ProjectSigma-main/tools/extension-kit/index.mjs'),
    path.resolve(__dirname, '../../../../../ProjectSigma-main/tools/extension-kit/index.mjs'),
    'D:/ProjectSigma-main/tools/extension-kit/index.mjs',
    '/data/data/com.termux/files/home/ProjectSigma-main/tools/extension-kit/index.mjs',
].find(p => fs.existsSync(p));
const { startSigma, basePng } = await import(pathToFileURL(KIT).href);
const REGEX_DIR = path.resolve(path.dirname(KIT), '../../extensions/installed/regex');
const HAS_REGEX = fs.existsSync(path.join(REGEX_DIR, 'manifest.json'));

register('./helpers/modules-hook.mjs', import.meta.url);
const { default: provider } = await import('../client/realm-provider.js');
const { buildZip, encodeRisumModule, pngWithCard } = await import('./helpers/charx.mjs');
const { translateRisuRegex } = await import('../server/regex-translate.js');
const { MAX_CARD_REGEX_BYTES, MAX_STORED_MODULE_BYTES } = await import('../server/index.js');
const { MAX_MODULE_FILE } = await import('../server/risu-module.js');

const EXT = 'risuai-realm-plus';
const SAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/regex/sample-module-regex.json'), 'utf8'));
const EXPECT = translateRisuRegex(SAMPLE);
const LUA = 'SECRETLUA_print("never on the card")';
const LORE = 'LOREMARKER only in the module';
const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const OWN_SCRIPT = { id: 'card-own', scriptName: 'own', findRegex: '/own/g', replaceString: 'mine', trimStrings: [], placement: [2], disabled: false, markdownOnly: false, promptOnly: false, runOnEdit: false, substituteRegex: 0, minDepth: null, maxDepth: null };

function moduleOf(extra = {}) {
    return {
        name: 'Test Module', description: 'd', id: 'm1', regex: SAMPLE,
        trigger: [{ comment: 't', effect: [{ type: 'triggerlua', code: LUA }] }],
        lorebook: [{ key: 'k', comment: 'c', content: LORE, alwaysActive: false }],
        ...extra,
    };
}
function cardOf(extensions = {}, name = 'Realm Test') {
    return {
        spec: 'chara_card_v3', spec_version: '3.0',
        data: {
            name, description: 'desc', first_mes: 'hi', tags: [], extensions,
            assets: [
                { type: 'icon', name: 'main', uri: 'embeded://assets/icon/images/main.png', ext: 'png' },
                { type: 'x-risu-asset', name: 'pic', uri: 'embeded://assets/other/image/pic.png', ext: 'png' },
            ],
        },
    };
}
function charx({ card = cardOf({ regex_scripts: [OWN_SCRIPT] }), moduleBytes = null } = {}) {
    const members = [
        { name: 'card.json', data: JSON.stringify(card) },
        { name: 'assets/icon/images/main.png', data: basePng, stored: true },
        { name: 'assets/other/image/pic.png', data: basePng, stored: true },
    ];
    if (moduleBytes) members.push({ name: 'module.risum', data: moduleBytes });
    return buildZip(members);
}

// ---- the stand-in Realm
const downloads = new Map();
const probe = { hangStarted: false, hangCancelled: false };
const realFetch = globalThis.fetch;
const DL = 'https://realm.risuai.net/api/v1/download/dynamic/';
function standIn(url, init) {
    const u = String(url instanceof URL ? url.href : (url?.url ?? url));
    if (!u.startsWith(DL)) return null;
    const spec = downloads.get(u.slice(DL.length).split('?')[0]);
    if (!spec) return new Response(JSON.stringify({ error: 'nf', message: 'no such character' }), { status: 404, headers: { 'content-type': 'application/json' } });
    if (spec.hang) {
        let timer;
        const body = new ReadableStream({
            start(c) { c.enqueue(new Uint8Array(4096).fill(7)); probe.hangStarted = true; timer = setInterval(() => {}, 1000); },
            cancel() { probe.hangCancelled = true; clearInterval(timer); },
        });
        return new Response(body, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
    }
    return new Response(spec.bytes, { status: 200, headers: { 'content-type': spec.type || 'application/octet-stream' } });
}

// ---- the page's side: a CoreAPI stand-in over an account's session
const toasts = [];
function coreFor(session, { failLink = false } = {}) {
    return {
        apiRequest: (p, m, d, o) => (failLink && p.endsWith('/link') ? Promise.reject(new Error('link down')) : session.apiRequest(p, m, d, o)),
        showToast: (m, t) => toasts.push([m, t]),
    };
}
async function importAs(session, realmId, opts = {}, core = {}) {
    await provider.init(coreFor(session, core));
    return provider.importCharacter(realmId, { id: realmId, name: 'Realm Test', tags: [] }, opts);
}

let sigma, alice, bob;
const tmpDir = () => path.join(sigma.dataDir, 'extensions', '.data', EXT, 'tmp');
const tmpFiles = () => (fs.existsSync(tmpDir()) ? fs.readdirSync(tmpDir()) : []);
const rows = (handle, where = '1=1', ...args) => sigma.db(handle).prepare(`SELECT * FROM x_risuai_realm_plus_modules WHERE ${where}`).all(...args);
const cardOfChar = async (session, id) => {
    const body = (await session.api(`/characters/${id}`)).body;
    return body.card || body;
};
const until = async (fn, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn()) return true; await new Promise(r => setTimeout(r, 25)); }
    return false;
};

before(async () => {
    console.info = () => {};
    globalThis.fetch = (url, init) => standIn(url, init) || realFetch(url, init);
    sigma = await startSigma({
        extensions: HAS_REGEX ? [EXT_DIR, REGEX_DIR] : [EXT_DIR],
        accounts: [{ handle: 'alice', password: 'correct horse 1', admin: true }, { handle: 'bob', password: 'correct horse 2' }],
        prefix: 'sigma-risuai-realm-plus',
    });
    alice = await sigma.signIn('alice', 'correct horse 1');
    bob = await sigma.signIn('bob', 'correct horse 2');
    for (const s of [alice, bob]) {
        const r = await s.enable(EXT, true);
        assert.ok(r.status < 300, JSON.stringify(r.body));
    }
    if (HAS_REGEX) await alice.enable('regex', true);
});

after(() => {
    globalThis.fetch = realFetch;
    try { sigma?.close(); } catch { /* down */ }
});

test('the extension loads under its id, with no refused table prefix', async () => {
    const list = (await alice.api('/extensions')).body;
    const row = (list.extensions || list).find(x => x.id === EXT);
    assert.ok(row, 'installed');
    assert.equal(row.error, undefined);
});

let motoko;  // the first import's character
test('a charx import keeps the module off the card and its translated regex on it', async () => {
    downloads.set(ID(1), { bytes: charx({ moduleBytes: encodeRisumModule(moduleOf(), { assets: [Buffer.from('img')] }) }) });
    toasts.length = 0;
    const r = await importAs(alice, ID(1));
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(r.alreadyPresent, false);
    motoko = r.id;

    const card = await cardOfChar(alice, motoko);
    const json = JSON.stringify(card);
    assert.ok(!json.includes('SECRETLUA'), 'no Lua on the card');
    assert.ok(!json.includes('LOREMARKER'), 'no module lorebook on the card');
    assert.ok(!/"trigger"/.test(json) && !/triggerlua/.test(json), 'no trigger data on the card');
    const ids = card.data.extensions.regex_scripts.map(s => s.id);
    assert.equal(ids.length, 1 + EXPECT.scripts.length);
    assert.equal(ids[0], 'card-own', 'the card\'s own script is kept, first');
    for (const s of EXPECT.scripts) assert.ok(ids.includes(s.id));
    assert.equal(new Set(ids).size, ids.length, 'no duplicate ids');
    assert.equal(r.mediaCount, 1, 'the asset joined the gallery');

    // one brief toast, saying how many were skipped
    assert.equal(toasts.length, 1);
    assert.match(toasts[0][0], new RegExp(`${EXPECT.report.skipped.length} Risu regex scripts were skipped`));

    // the module is in the table, bound, with no pending stage left on it
    const [row] = rows('alice', 'char_id = ?', motoko);
    assert.ok(row, 'module row');
    assert.equal(row.stage_id, null);
    assert.equal(row.realm_id, ID(1));
    assert.ok(row.module.includes('SECRETLUA'));
    assert.equal(JSON.parse(row.report).translated, EXPECT.report.translated);
});

test('GET /module answers the stored module, 404 for a character without one', async () => {
    const ok = await alice.ext(EXT)(`/module/${motoko}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.module.trigger[0].effect[0].code, LUA);
    assert.equal(ok.body.module.lorebook[0].content, LORE);
    assert.equal(ok.body.realmId, ID(1));
    assert.equal((await alice.ext(EXT)('/module/not-a-character')).status, 404);
});

test('the command answers a character\'s module (client wiring is checked in the kit page below)', async () => {
    const mod = fs.readFileSync(path.join(EXT_DIR, 'client/index.js'), 'utf8');
    assert.match(mod, /commands\.register\('get-module'/);
});

test('/link refuses what it cannot bind', async () => {
    const f = alice.ext(EXT);
    assert.equal((await f('/link', 'POST', {})).status, 400);
    assert.equal((await f('/link', 'POST', { stageId: 'nope', charId: motoko })).status, 404);
    assert.equal((await f('/link', 'POST', { stageId: 'nope', charId: 'no-such-char' })).status, 404);
});

test('an identical re-import gives a character its missing module, and never replaces one', async () => {
    const card = () => cardOf({}, 'No Regex Card');
    const moduleBytes = (name) => encodeRisumModule(moduleOf({ name, regex: [] }));
    // already in the library without a module, as a card imported before this extension is
    downloads.set(ID(20), { bytes: charx({ card: card() }) });
    const first = await importAs(alice, ID(20));
    assert.equal(first.success, true);
    assert.equal(rows('alice', 'char_id = ?', first.id).length, 0);

    downloads.set(ID(20), { bytes: charx({ card: card(), moduleBytes: moduleBytes('First Module') }) });
    const again = await importAs(alice, ID(20));
    assert.equal(again.alreadyPresent, true);
    assert.equal(again.skippedReason, 'identical');
    assert.equal(again.id, first.id);
    const [row] = rows('alice', 'char_id = ?', first.id);
    assert.ok(row, 'the identical card gained its module');
    assert.match(row.module, /First Module/);

    downloads.set(ID(20), { bytes: charx({ card: card(), moduleBytes: moduleBytes('Second Module') }) });
    await importAs(alice, ID(20));
    const after = rows('alice', 'char_id = ?', first.id);
    assert.equal(after.length, 1);
    assert.match(after[0].module, /First Module/, 'an existing module stands');
    assert.equal(rows('alice', 'char_id IS NULL').length, 0, 'the unused module does not linger');
});

test('a duplicate import is skipped: nothing is bound, the existing module stands', async () => {
    downloads.set(ID(1), { bytes: charx({ moduleBytes: encodeRisumModule(moduleOf({ name: 'Changed' })) }) });
    const before = rows('alice', 'char_id = ?', motoko)[0];
    toasts.length = 0;
    const r = await importAs(alice, ID(1));
    assert.equal(r.success, true);
    assert.equal(r.alreadyPresent, true);
    assert.equal(r.id, motoko);
    assert.equal(toasts.length, 0, 'a skip says nothing about scripts');
    const after = rows('alice', 'char_id = ?', motoko);
    assert.equal(after.length, 1);
    assert.equal(after[0].updated_at, before.updated_at);
    assert.equal(JSON.parse(after[0].module).name, 'Test Module');
    // the character keeps its module, so the one staged for this import is dropped, not left for the hour
    assert.equal(rows('alice', 'char_id IS NULL').length, 0);
});

test('a pending row older than the stage\'s hour is swept by the next stage', async () => {
    // a stage nobody committed leaves a row pending
    downloads.set(ID(21), { bytes: charx({ card: cardOf({}, 'Never Committed'), moduleBytes: encodeRisumModule(moduleOf({ name: 'Abandoned' })) }) });
    const abandoned = await alice.ext(EXT)('/stage', 'POST', { id: ID(21) });
    assert.equal(abandoned.status, 200);
    assert.equal(rows('alice', 'char_id IS NULL').length, 1);
    sigma.db('alice').prepare('UPDATE x_risuai_realm_plus_modules SET created_at = ? WHERE char_id IS NULL').run(Date.now() - 2 * 3600 * 1000);
    downloads.set(ID(9), { bytes: Buffer.from('not a card'), type: 'text/plain' });
    await alice.ext(EXT)('/stage', 'POST', { id: ID(9) });
    assert.equal(rows('alice', 'char_id IS NULL').length, 0);
});

test('Import Anyway (copy) makes a new character with a module of its own', async () => {
    downloads.set(ID(1), { bytes: charx({ moduleBytes: encodeRisumModule(moduleOf({ name: 'Copy' })) }) });
    const r = await importAs(alice, ID(1), { onExisting: 'copy' });
    assert.equal(r.success, true);
    assert.equal(r.alreadyPresent, false);
    assert.notEqual(r.id, motoko);
    assert.equal(JSON.parse(rows('alice', 'char_id = ?', r.id)[0].module).name, 'Copy');
    assert.equal(JSON.parse(rows('alice', 'char_id = ?', motoko)[0].module).name, 'Test Module', 'the original keeps its own');
});

test('Replace writes onto the existing character and swaps its module', async () => {
    downloads.set(ID(1), { bytes: charx({ moduleBytes: encodeRisumModule(moduleOf({ name: 'Replaced' })) }) });
    const r = await importAs(alice, ID(1), { onExisting: { replace: motoko } });
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(r.replaced, true);
    assert.equal(r.id, motoko);
    const mine = rows('alice', 'char_id = ?', motoko);
    assert.equal(mine.length, 1, 'one row a character');
    assert.equal(JSON.parse(mine[0].module).name, 'Replaced');
    const card = await cardOfChar(alice, motoko);
    const ids = card.data.extensions.regex_scripts.map(s => s.id);
    assert.equal(new Set(ids).size, ids.length);
});

test('a failed link is a warning: the import stands, the card is there, the module waits unbound', async () => {
    downloads.set(ID(2), { bytes: charx({ card: cardOf({}, 'Link Fail'), moduleBytes: encodeRisumModule(moduleOf()) }) });
    const warns = [];
    const warn = console.warn;
    console.warn = (...a) => warns.push(a.join(' '));
    let r;
    try { r = await importAs(alice, ID(2), {}, { failLink: true }); } finally { console.warn = warn; }
    assert.equal(r.success, true);
    assert.ok(warns.some(w => /could not be bound/.test(w)));
    assert.equal(rows('alice', 'char_id = ?', r.id).length, 0);
    assert.equal((await alice.ext(EXT)(`/module/${r.id}`)).status, 404);
});

test('a corrupt module does not fail the import', async () => {
    const bad = encodeRisumModule(moduleOf());
    bad[0] = 0;  // the wrong magic byte
    downloads.set(ID(3), { bytes: charx({ card: cardOf({ regex_scripts: [OWN_SCRIPT] }, 'Corrupt'), moduleBytes: bad }) });
    const staged = await alice.ext(EXT)('/stage', 'POST', { id: ID(3) });
    assert.equal(staged.status, 200);
    assert.equal(staged.body.module, null);
    assert.match(staged.body.moduleError, /Risu module could not be read/);
    await alice.apiRequest(`/characters/import/stage/${staged.body.stageId}`, 'DELETE');

    toasts.length = 0;
    const warn = console.warn; console.warn = () => {};
    let r;
    try { r = await importAs(alice, ID(3)); } finally { console.warn = warn; }
    assert.equal(r.success, true);
    assert.equal(rows('alice', 'char_id = ?', r.id).length, 0);
    const card = await cardOfChar(alice, r.id);
    assert.deepEqual(card.data.extensions.regex_scripts.map(s => s.id), ['card-own']);
    assert.equal(toasts.length, 1);
    assert.match(toasts[0][0], /Risu module was not kept/);
});

test('a charx without a module imports as before', async () => {
    downloads.set(ID(4), { bytes: charx({ card: cardOf({}, 'Plain') }) });
    const staged = await alice.ext(EXT)('/stage', 'POST', { id: ID(4) });
    assert.equal(staged.body.module, null);
    assert.equal(staged.body.moduleError, null);
    assert.deepEqual(staged.body.regexScripts, []);
    await alice.apiRequest(`/characters/import/stage/${staged.body.stageId}`, 'DELETE');
});

test('a PNG card: its customScripts translate onto regex_scripts and stay where they are; no module row', async () => {
    const card = cardOf({ risuai: { customScripts: SAMPLE, backgroundHTML: '<i>x</i>' } }, 'Png Card');
    downloads.set(ID(5), { bytes: pngWithCard(basePng, card) });
    const r = await importAs(alice, ID(5));
    assert.equal(r.success, true, JSON.stringify(r));
    const stored = await cardOfChar(alice, r.id);
    assert.equal(stored.data.extensions.regex_scripts.length, EXPECT.scripts.length);
    assert.equal(stored.data.extensions.risuai.customScripts.length, SAMPLE.length, 'the card\'s own data is untouched');
    assert.equal(rows('alice', 'char_id = ?', r.id).length, 0);
    assert.equal((await alice.ext(EXT)(`/module/${r.id}`)).status, 404);
});

test('deleting a character takes its module row', async () => {
    const copy = rows('alice', 'char_id IS NOT NULL').find(r => JSON.parse(r.module).name === 'Copy');
    assert.ok(copy);
    const del = await alice.api(`/characters/${copy.char_id}`, 'DELETE');
    assert.equal(del.status, 200);
    assert.equal(rows('alice', 'char_id = ?', copy.char_id).length, 0);
    assert.equal((await alice.ext(EXT)(`/module/${copy.char_id}`)).status, 404);
});

test('accounts stay apart: the other library has its own table, rows and routes', async () => {
    assert.equal((await bob.ext(EXT)(`/module/${motoko}`)).status, 404);
    assert.equal(rows('bob').length, 0);
    downloads.set(ID(1), { bytes: charx({ moduleBytes: encodeRisumModule(moduleOf({ name: 'Bob\'s' })) }) });
    const r = await importAs(bob, ID(1));
    assert.equal(r.success, true);
    assert.equal(r.alreadyPresent, false, 'bob has no copy of it');
    assert.notEqual(r.id, motoko);
    assert.equal(JSON.parse(rows('bob', 'char_id = ?', r.id)[0].module).name, 'Bob\'s');
    assert.equal(JSON.parse(rows('alice', 'char_id = ?', motoko)[0].module).name, 'Replaced');
    // alice's character id is not bound by bob's link
    assert.equal((await bob.ext(EXT)('/link', 'POST', { stageId: 'x', charId: motoko })).status, 404);
});

test('the Regex extension\'s character-scripts surface sees the translated scripts', { skip: HAS_REGEX ? false : 'the regex extension is not beside the kit' }, async () => {
    const r = await alice.ext('regex')(`/scripts?scope=character&owner=${motoko}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const ids = r.body.scripts.map(s => s.id);
    for (const s of EXPECT.scripts) assert.ok(ids.includes(s.id), `regex extension lists ${s.id}`);
    assert.ok(ids.includes('card-own'));
    const info = await alice.ext('regex')(`/characters/${motoko}`);
    assert.equal(info.body.scripts.length, r.body.scripts.length);
});

test('regex over the card budget: none on the card, the report kept in the module row, one toast', async () => {
    assert.equal(MAX_CARD_REGEX_BYTES, 256 * 1024);
    const many = Array.from({ length: 40 }, (_, i) => ({ comment: `big ${i}`, in: `word${i}`, out: 'x'.repeat(8000), type: 'editoutput', ableFlag: false, flag: '' }));
    downloads.set(ID(10), { bytes: charx({ card: cardOf({ regex_scripts: [OWN_SCRIPT] }, 'Big Regex'), moduleBytes: encodeRisumModule(moduleOf({ regex: many })) }) });
    toasts.length = 0;
    const warn = console.warn; console.warn = () => {};
    let r;
    try { r = await importAs(alice, ID(10)); } finally { console.warn = warn; }
    assert.equal(r.success, true);
    const card = await cardOfChar(alice, r.id);
    assert.deepEqual(card.data.extensions.regex_scripts.map(s => s.id), ['card-own'], 'none of the translated set');
    const [row] = rows('alice', 'char_id = ?', r.id);
    assert.ok(row, 'the module is still kept');
    const report = JSON.parse(row.report);
    assert.equal(report.translated, 40);
    assert.equal(report.tooLarge.budget, MAX_CARD_REGEX_BYTES);
    assert.ok(report.tooLarge.bytes > MAX_CARD_REGEX_BYTES);
    assert.equal(toasts.length, 1);
    assert.match(toasts[0][0], /regex was too large for the card/);
});

test('a module over the stored cap is not kept, the report says so, the import finishes', async () => {
    assert.equal(MAX_STORED_MODULE_BYTES, 16 * 1024 * 1024);
    const lore = Array.from({ length: 9 }, (_, i) => ({ key: `k${i}`, content: 'L'.repeat(2 * 1024 * 1024) }));
    downloads.set(ID(11), { bytes: charx({ card: cardOf({}, 'Huge Module'), moduleBytes: encodeRisumModule(moduleOf({ lorebook: lore })) }) });
    const staged = await alice.ext(EXT)('/stage', 'POST', { id: ID(11) });
    assert.equal(staged.status, 200);
    assert.equal(staged.body.module, null);
    assert.match(staged.body.moduleError, /over the 16777216 byte cap/);
    assert.equal(staged.body.regexScripts.length, EXPECT.scripts.length, 'the regex still translates');
    assert.ok(staged.body.regexReport.moduleNotStored.bytes > MAX_STORED_MODULE_BYTES);
    await alice.apiRequest(`/characters/import/stage/${staged.body.stageId}`, 'DELETE');
    assert.equal(rows('alice', 'stage_id = ?', staged.body.stageId).length, 0);
});

test('a module.risum over the reader\'s file cap means no module; the import still succeeds', async () => {
    assert.equal(MAX_MODULE_FILE, 64 * 1024 * 1024);
    downloads.set(ID(12), { bytes: charx({ card: cardOf({}, 'Oversized'), moduleBytes: Buffer.alloc(MAX_MODULE_FILE + 1024) }) });
    const warn = console.warn; console.warn = () => {};
    let staged;
    try { staged = await alice.ext(EXT)('/stage', 'POST', { id: ID(12) }); } finally { console.warn = warn; }
    assert.equal(staged.status, 200);
    assert.equal(staged.body.module, null);
    assert.match(staged.body.moduleError, /byte limit/);
    await alice.apiRequest(`/characters/import/stage/${staged.body.stageId}`, 'DELETE');
    assert.deepEqual(tmpFiles(), []);
});

test('a download that cannot be written answers a clear error and leaves nothing behind', async () => {
    downloads.set(ID(13), { bytes: charx({ card: cardOf({}, 'No Disk') }) });
    fs.mkdirSync(tmpDir(), { recursive: true });
    fs.chmodSync(tmpDir(), 0o500);
    let r;
    try { r = await alice.ext(EXT)('/stage', 'POST', { id: ID(13) }); } finally { fs.chmodSync(tmpDir(), 0o700); }
    // (a full disk takes the same path, answering 507 'the server's disk is full')
    assert.ok(r.status === 500 || r.status === 507, JSON.stringify(r));
    assert.match(r.body.error, /could not be saved|disk is full/);
    assert.deepEqual(tmpFiles(), []);
});

test('the temporary file is deleted as soon as staging finishes', async () => {
    downloads.set(ID(14), { bytes: charx({ card: cardOf({}, 'Early Delete') }) });
    const r = await alice.ext(EXT)('/stage', 'POST', { id: ID(14) });
    assert.equal(r.status, 200);
    assert.deepEqual(tmpFiles(), [], 'gone by the time the answer is out');
    await alice.apiRequest(`/characters/import/stage/${r.body.stageId}`, 'DELETE');
});

test('the temporary file is gone after a success, a refusal and an abort', async () => {
    assert.deepEqual(tmpFiles(), [], 'after the successes above');

    // refused by the stage (neither a PNG nor a charx)
    downloads.set(ID(6), { bytes: Buffer.from('this is not a card'), type: 'text/plain' });
    const refused = await alice.ext(EXT)('/stage', 'POST', { id: ID(6) });
    assert.ok(refused.status >= 400 && refused.status < 500, String(refused.status));
    assert.deepEqual(tmpFiles(), [], 'after a refusal');

    // the Realm refusing with JSON
    const gone = await alice.ext(EXT)('/stage', 'POST', { id: ID(7) });
    assert.equal(gone.status, 404);
    assert.deepEqual(tmpFiles(), [], 'after the Realm\'s refusal');

    // the page leaving mid-download
    const pendingBefore = rows('alice', 'stage_id IS NOT NULL').length;
    downloads.set(ID(8), { hang: true });
    const ctl = new AbortController();
    const pending = alice.apiRequest(`/ext/${EXT}/stage`, 'POST', { id: ID(8) }, { signal: ctl.signal }).catch(() => null);
    assert.ok(await until(() => probe.hangStarted && tmpFiles().length === 1), 'the download reached the disk');
    ctl.abort();
    await pending;
    assert.ok(await until(() => tmpFiles().length === 0), `the file is removed after an abort (${tmpFiles()})`);
    assert.ok(await until(() => probe.hangCancelled), 'the download was hung up on');
    assert.equal(rows('alice', 'stage_id IS NOT NULL').length, pendingBefore, 'an abort leaves no pending module');
});
