// Risu regex scripts (customscript) to SillyTavern regex_scripts entries, a stopgap until Sigma
// ships regex of its own. Behaviour follows RisuAI src/ts/process/scripts.ts (processScriptFull).
// Pure and standalone: a pattern is only compiled here, never run.
import { createHash } from 'node:crypto';

// Where each Risu type runs. Display and process scripts see every message, so both roles.
const TYPES = {
    editinput: { placement: [1], markdownOnly: false, promptOnly: false },
    editoutput: { placement: [2], markdownOnly: false, promptOnly: false },
    editdisplay: { placement: [1, 2], markdownOnly: true, promptOnly: false },
    editprocess: { placement: [1, 2], markdownOnly: false, promptOnly: true },
};

// These only change Risu's own state or move text around; in ST the directive would be pasted into
// the chat, so such a script is skipped rather than translated.
const SKIP_DIRECTIVES = ['@@emo', '@@inject', '@@move_top', '@@move_bottom', '@@repeat_back'];
const SKIP_ACTIONS = ['inject', 'move_top', 'move_bottom', 'repeat_back'];

// Macros ST's regex engine expands itself; anything else in braces stays as typed.
const ST_MACROS = new Set(['char', 'user', 'getvar', 'getglobalvar', 'newline', 'noop']);

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// Flags the way Risu settles them: ableFlag off means plain g, directives come out of the flag text,
// unknown letters and repeats go, and nothing left means u.
function readRisuFlags(raw) {
    const actions = [];
    let order = null;
    let flag = 'g';
    if (raw.ableFlag) {
        let text = typeof raw.flag === 'string' ? raw.flag : '';
        // <a, b> blocks carry directives and are cut out of the flag text
        if (text.includes('<')) {
            text = text.replace(/<(.+?)>/g, (_, inner) => {
                for (const part of inner.split(',').map(p => p.trim())) {
                    if (part.startsWith('order ')) order = parseInt(part.slice(6));
                    else actions.push(part);
                }
                return '';
            });
        }
        flag = text || 'g';
    }
    flag = flag.trim().replace(/[^dgimsuvy]/g, '');
    flag = [...new Set(flag)].join('');
    return { flags: flag || 'u', actions, order };
}

// Escapes what ST's /body/flags parser would trip on: a bare slash, and line breaks (its "." cannot
// cross them, so a raw one would cut the body short).
export function bodyForSt(body) {
    let out = '';
    for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (c === '\\' && i + 1 < body.length) {
            const n = body[++i];
            out += n === '\n' ? '\\n' : n === '\r' ? '\\r' : '\\' + n;
        } else if (c === '/') out += '\\/';
        else if (c === '\n') out += '\\n';
        else if (c === '\r') out += '\\r';
        else if (c === ' ') out += '\\u2028';
        else if (c === ' ') out += '\\u2029';
        else out += c;
    }
    return out;
}

// Capture groups by a static scan, so the pattern never has to run.
function countGroups(body) {
    let n = 0;
    let inClass = false;
    for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (c === '\\') i++;
        else if (inClass) inClass = c !== ']';
        else if (c === '[') inClass = true;
        else if (c === '(') {
            if (body[i + 1] !== '?') n++;
            else if (body[i + 2] === '<' && body[i + 3] !== '=' && body[i + 3] !== '!') n++;
        }
    }
    return n;
}

// Risu's out is String.replace text; ST's runner only knows $N, $<name> and {{match}}.
// Returns the ST text, or { skip } when the meaning cannot be written in ST.
function convertOut(out, groups, lossy) {
    let text = '';
    for (let i = 0; i < out.length; i++) {
        if (out.startsWith('{{data}}', i)) {
            // the pinned Risu replaces {{data}} with '$&' through a replace that maps it to itself,
            // so it stays literal there; the documented intent is the match, which is what we write
            lossy.add('{{data}} written as the match ($0); the pinned Risu build leaves it literal');
            text += '$0';
            i += 7;
            continue;
        }
        if (out[i] !== '$') { text += out[i]; continue; }
        const n = out[i + 1];
        if (n === '$') {
            const after = out[i + 2];
            // a literal $ before a digit or < would be read as a group reference by ST
            if (after !== undefined && /[0-9<]/.test(after)) return { skip: 'replacement has "$$" before a digit or "<", which ST would read as a group reference' };
            text += '$';
            i++;
        } else if (n === '&') {
            text += '$0';
            i++;
        } else if (n === '`' || n === "'") {
            return { skip: `replacement uses $${n} (text before/after the match), which ST cannot express` };
        } else if (n !== undefined && /[0-9]/.test(n)) {
            // JS reads $NN when that group exists, else $N followed by a digit, else literal text
            const two = /^[0-9]{2}/.exec(out.slice(i + 1, i + 3))?.[0];
            let digits = n;
            if (two && Number(two) >= 1 && Number(two) <= groups) digits = two;
            const num = Number(digits);
            if (num === 0) return { skip: 'replacement uses $0, which is literal text in Risu but the whole match in ST' };
            if (num > groups) lossy.add(`$${digits} refers to a group the pattern lacks: Risu keeps it as text, ST drops it`);
            else if (two && digits.length === 1) lossy.add(`$${two} read as $${n} plus a digit, as Risu does; ST may read it as one group number`);
            text += '$' + String(num);
            i += digits.length;
        } else text += '$';
    }
    return { text };
}

// CBS names the way Risu normalises them: lower case, no spaces, "_" or "-"
function cbsNames(text) {
    const names = [];
    for (const m of text.matchAll(/\{\{\s*([#/:?]?)\s*([^{}:\s]*)/g)) {
        const name = m[2].toLowerCase().replace(/[_-]/g, '');
        names.push(m[1] + name);
    }
    return names;
}

function unsupportedMacros(text) {
    const bad = [...new Set(cbsNames(text).filter(n => !ST_MACROS.has(n)))];
    return bad.slice(0, 8).map(n => `{{${n}}}`).join(', ') + (bad.length > 8 ? ', ...' : '');
}

function makeId(raw, index) {
    const h = createHash('sha256')
        .update(JSON.stringify([index, raw.comment, raw.in, raw.out, raw.type, raw.flag, !!raw.ableFlag]))
        .digest('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// One script to { script, lossy[] } or { skip }, plus the order directive it carried.
function translateOne(raw, index) {
    const name = typeof raw.comment === 'string' && raw.comment.trim() ? raw.comment : `Risu script ${index + 1}`;
    const fail = (reason) => ({ name, skip: reason });
    if (typeof raw.in !== 'string' || typeof raw.out !== 'string' || typeof raw.type !== 'string') {
        return fail('missing in, out or type');
    }
    const lossy = new Set();
    // Risu ignores an empty pattern, and nothing here can run a "disabled" or translation-display script
    if (raw.in === '') return fail('empty pattern, which Risu ignores');
    if (raw.type === 'disabled') return fail('type disabled: Risu never runs it and the type it was meant for is unknown');
    if (raw.type === 'edittrans') return fail('type edittrans runs on translated display text, which ST has no hook for');
    const mode = TYPES[raw.type];
    if (!mode) return fail(`unknown type "${raw.type}"`);

    const { flags, actions, order } = readRisuFlags(raw);
    const hasOrder = order !== null;
    if (hasOrder) lossy.add(`<order ${Number.isNaN(order) ? 'NaN' : order}> applied by sorting this list only; Risu sorts character, preset and module scripts together`);

    const bad = SKIP_DIRECTIVES.find(d => raw.out.startsWith(d)) || SKIP_ACTIONS.map(a => '<' + a + '>').find((_, i) => actions.includes(SKIP_ACTIONS[i]));
    if (bad) return { ...fail(`${bad} has no ST equivalent and would paste the directive into the chat`), hasOrder, order };

    // a pattern Risu cannot compile never runs there either
    const compile = (body, f) => { try { return new RegExp(body, f); } catch { return null; } };
    const cbsInput = actions.includes('cbs');
    const probe = cbsInput ? raw.in.replace(/\{\{[^{}]*\}\}/g, 'x') : raw.in;
    if (!compile(probe, flags)) return { ...fail('pattern does not compile'), hasOrder, order };

    let stFlags = flags;
    if (flags.includes('y')) return { ...fail('sticky flag y changes where matches may start and ST has no such flag'), hasOrder, order };
    if (flags.includes('v')) {
        stFlags = stFlags.replace('v', 'u');
        if (!compile(probe, stFlags)) return { ...fail('flag v (set notation) does not compile as u'), hasOrder, order };
        lossy.add('flag v rewritten as u, which ST accepts; set notation inside classes may differ');
    }
    stFlags = stFlags.replace('d', '');
    if (!stFlags) stFlags = 'u';

    // <cbs> expands macros in the pattern; ST's raw substitution knows only a few of them
    let substitute = 0;
    if (cbsInput) {
        const names = cbsNames(raw.in);
        if (names.some(n => !ST_MACROS.has(n))) return { ...fail(`<cbs> pattern uses macros ST cannot expand (${unsupportedMacros(raw.in)}), so it would match the wrong text`), hasOrder, order };
        if (names.length) substitute = 1;
    }

    let out = raw.out.replaceAll('$n', '\n');
    if (out.endsWith('>') && !actions.includes('no_end_nl')) out += '\n';
    const conv = convertOut(out, countGroups(raw.in), lossy);
    if (conv.skip) return { ...fail(conv.skip), hasOrder, order };

    // CBS has no ST twin: an unexpanded macro is stray text, not breakage, so the script is kept
    const macros = unsupportedMacros(conv.text);
    if (macros) lossy.add(`CBS macros left unexpanded by ST: ${macros}`);
    if (/<(user|char|bot)>/i.test(conv.text)) lossy.add('<user>/<char>/<bot> are not expanded by ST');
    if (/<style[\s>]/i.test(raw.out)) lossy.add('<style> is not scoped or class-prefixed the way Risu does');

    return {
        name,
        hasOrder,
        order,
        lossy: [...lossy],
        script: {
            id: makeId(raw, index),
            scriptName: name,
            findRegex: `/${bodyForSt(raw.in)}/${stFlags}`,
            replaceString: conv.text,
            trimStrings: [],
            placement: [...mode.placement],
            disabled: false,
            markdownOnly: mode.markdownOnly,
            promptOnly: mode.promptOnly,
            runOnEdit: false,
            substituteRegex: substitute,
            minDepth: null,
            maxDepth: null,
        },
    };
}

export function translateRisuRegex(scripts) {
    const report = { translated: 0, lossy: [], skipped: [] };
    if (!Array.isArray(scripts)) return { scripts: [], report };

    const done = [];
    let anyOrder = false;
    scripts.forEach((raw, index) => {
        if (!isObject(raw)) {
            report.skipped.push({ name: `Risu script ${index + 1}`, reason: 'not an object' });
            return;
        }
        let r;
        try {
            r = translateOne(raw, index);
        } catch {
            r = { name: `Risu script ${index + 1}`, skip: 'could not be read' };
        }
        if (r.hasOrder) anyOrder = true;
        if (r.skip) report.skipped.push({ name: r.name, reason: r.skip });
        else done.push(r);
    });

    // Risu sorts by order, highest first, only when some script carries one; the sort is stable
    if (anyOrder) done.sort((a, b) => (b.order || 0) - (a.order || 0));

    const out = [];
    for (const r of done) {
        out.push(r.script);
        if (r.lossy.length) report.lossy.push({ name: r.name, reasons: r.lossy });
    }
    report.translated = out.length;
    return { scripts: out, report };
}
