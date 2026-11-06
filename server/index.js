// RisuAI Realm Plus, the server half: a download streamed to a temporary file, so the page never carries a
// charx (some pass 150 MB). The file is read for its Risu module (kept in this extension's own table,
// never on the card), then staged as the import would stage an upload.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { realmIdOf } from '../client/realm-id.js';
import { readModuleFromCharx } from './risu-module.js';
import { translateRisuRegex } from './regex-translate.js';
import { migrations as moduleMigrations, savePending, bindPending, dropPending, hasModule, readModule, sweepPending } from './module-store.js';

export const migrations = moduleMigrations;

const DOWNLOAD = 'https://realm.risuai.net/api/v1/download/dynamic/';

// a charx past this is refused rather than filling the disk (the biggest cards seen pass 150 MB)
const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;

/** The translated regex a card may carry (its JSON): over it, none is written, since a partial set can render wrong. */
export const MAX_CARD_REGEX_BYTES = 256 * 1024;
/** The module JSON this extension will keep in its table; over it, the import finishes without the module. */
export const MAX_STORED_MODULE_BYTES = 16 * 1024 * 1024;

// a refusal is a line of JSON: what came instead is read no further than its first few KB
const REFUSAL_TEXT_CAP = 16 * 1024;

async function refusalText(upstream) {
    const reader = upstream.body?.getReader();
    if (!reader) return '';
    const decoder = new TextDecoder();
    let text = '';
    while (text.length < REFUSAL_TEXT_CAP) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
    }
    reader.cancel().catch(() => {});
    return text.slice(0, REFUSAL_TEXT_CAP);
}

// the Realm refuses in JSON ({ error, message }), a 404 for an id it does not know; what else it
// answers is the file
async function refusalOf(upstream) {
    const text = await refusalText(upstream).catch(() => '');
    let said = '';
    try { said = JSON.parse(text)?.message || ''; } catch { /* not JSON */ }
    return said ? `the Realm says: ${String(said).slice(0, 200)}` : `the Realm answered ${upstream.status}`;
}

// the module the page is told of: counts only, never its text
function summaryOf(module, assetCount) {
    const count = (v) => (Array.isArray(v) ? v.length : 0);
    return {
        name: typeof module.name === 'string' ? module.name.slice(0, 200) : '',
        regex: count(module.regex),
        triggers: count(module.trigger),
        lorebook: count(module.lorebook),
        assets: assetCount || 0,
    };
}

// what a failed write to the temporary file says: a full disk is named, any other write failure is the server's, not the Realm's
function writeFailure(e, file) {
    if (e?.code === 'ENOSPC' || e?.code === 'EDQUOT') return Object.assign(new Error('the server\'s disk is full: the download could not be saved'), { statusCode: 507 });
    if (e?.path === file && e.code) return Object.assign(new Error(`the download could not be saved on the server (${e.code})`), { statusCode: 500 });
    return e;
}

// the body to a file on disk, never held whole; a signal stops it
async function downloadTo(file, body, signal) {
    let total = 0;
    const counter = new Transform({
        transform(chunk, _enc, cb) {
            total += chunk.length;
            if (total > MAX_DOWNLOAD_BYTES) {
                return cb(Object.assign(new Error(`the download is over ${MAX_DOWNLOAD_BYTES / (1024 * 1024)} MB`), { statusCode: 413 }));
            }
            cb(null, chunk);
        },
    });
    await pipeline(Readable.fromWeb(body), counter, fs.createWriteStream(file), { signal });
}

export function register(router, ctx) {
    // a restart ends every download in flight: whatever a crash left behind goes
    const tmpDir = path.join(ctx.dataDir(), 'tmp');
    fs.rmSync(tmpDir, { recursive: true, force: true });

    router.post('/stage', async (req, res) => {
        const id = realmIdOf(req.body?.id);
        if (!id) return res.status(400).json({ error: 'a Realm character id is a uuid' });
        // a page that leaves mid-download stops it, and the stage it was filling goes with it
        const hangUp = new AbortController();
        res.once('close', () => { if (!res.writableEnded) hangUp.abort(); });
        fs.mkdirSync(tmpDir, { recursive: true });
        const file = path.join(tmpDir, `${randomUUID()}.download`);
        let input = null;
        try {
            sweepPending(req.db);
            const upstream = await ctx.helpers.sameHostFetch(`${DOWNLOAD}${id}?cors=true`, {
                headers: { 'x-risu-api-version': '4' },
                signal: hangUp.signal,
            });
            if (!upstream.ok || /json/i.test(upstream.headers.get('content-type') || '')) {
                return res.status(upstream.status === 404 ? 404 : 502).json({ error: await refusalOf(upstream) });
            }
            try {
                await downloadTo(file, upstream.body, hangUp.signal);
            } catch (e) {
                throw writeFailure(e, file);
            }

            // a module that will not read costs the import its module, not the card
            let found = null;
            let moduleError = null;
            try {
                found = await readModuleFromCharx(file);
            } catch (e) {
                moduleError = `the card's Risu module could not be read: ${String(e?.message || e).slice(0, 200)}`;
                console.warn(`[risuai-realm-plus] ${id}: ${moduleError}`);
            }

            const readable = fs.createReadStream(file);
            input = readable;
            hangUp.signal.addEventListener('abort', () => readable.destroy(), { once: true });
            let staged;
            try {
                staged = await ctx.imports.stage(req, input, { name: `${id}.charx` });
            } finally {
                // the stage holds its own copy: ours goes now, not when the answer is built
                input.destroy();
                input = null;
                fs.rmSync(file, { force: true });
            }
            if (hangUp.signal.aborted) return;

            // a charx's regex lives in its module; a PNG card keeps it inline on the card
            const fromModule = Array.isArray(found?.module?.regex) ? found.module.regex : [];
            const onCard = staged.card?.data?.extensions?.risuai?.customScripts;
            const translated = translateRisuRegex(fromModule.length ? fromModule : onCard);
            const report = translated.report;
            let scripts = translated.scripts;
            // all or nothing: a part of a set can render wrong, and a card is not where a big set belongs
            const regexBytes = Buffer.byteLength(JSON.stringify(scripts));
            if (regexBytes > MAX_CARD_REGEX_BYTES) {
                report.tooLarge = { bytes: regexBytes, budget: MAX_CARD_REGEX_BYTES, scripts: scripts.length };
                console.warn(`[risuai-realm-plus] ${id}: ${scripts.length} translated regex scripts (${regexBytes} bytes) are over the card budget of ${MAX_CARD_REGEX_BYTES}; none written to the card`);
                scripts = [];
            }

            let summary = null;
            if (found) {
                const moduleBytes = Buffer.byteLength(JSON.stringify(found.module));
                if (moduleBytes > MAX_STORED_MODULE_BYTES) {
                    report.moduleNotStored = { bytes: moduleBytes, cap: MAX_STORED_MODULE_BYTES };
                    moduleError = `the card's Risu module (${moduleBytes} bytes) is over the ${MAX_STORED_MODULE_BYTES} byte cap and was not kept`;
                    console.warn(`[risuai-realm-plus] ${id}: ${moduleError}`);
                } else try {
                    savePending(req.db, { stageId: staged.stageId, realmId: id, module: found.module, report });
                    summary = summaryOf(found.module, found.assetCount);
                } catch (e) {
                    moduleError = `the card's Risu module could not be kept: ${String(e?.message || e).slice(0, 200)}`;
                    console.warn(`[risuai-realm-plus] ${id}: ${moduleError}`);
                }
            }
            res.json({ ...staged, regexScripts: scripts, regexReport: report, module: summary, moduleError });
        } catch (e) {
            if (hangUp.signal.aborted) return;
            // a stage refusal carries its status; anything else is the way to the Realm failing
            if (e?.statusCode) return res.status(e.statusCode).json({ error: e.message });
            res.status(502).json({ error: `the Realm could not be reached: ${e?.message || e}` });
        } finally {
            input?.destroy();
            fs.rmSync(file, { force: true });
        }
    });

    // the import committed: the pending module becomes the character's, replacing any it had
    router.post('/link', (req, res) => {
        const stageId = typeof req.body?.stageId === 'string' ? req.body.stageId : '';
        const charId = typeof req.body?.charId === 'string' ? req.body.charId : '';
        if (!stageId || !charId) return res.status(400).json({ error: 'stageId and charId are needed' });
        if (!ctx.stores.characters.getCharacter(req.db, charId)) return res.status(404).json({ error: 'no such character' });
        // an identical re-import gives a module to a character that has none; it never replaces one
        if (req.body?.ifMissing === true && hasModule(req.db, charId)) {
            dropPending(req.db, stageId);
            return res.json({ ok: true, kept: true });
        }
        if (!bindPending(req.db, stageId, charId)) return res.status(404).json({ error: 'no pending module for that stage' });
        res.json({ ok: true });
    });

    router.get('/module/:charId', (req, res) => {
        const row = readModule(req.db, String(req.params.charId));
        if (!row) return res.status(404).json({ error: 'no module stored for that character' });
        res.json(row);
    });
}
