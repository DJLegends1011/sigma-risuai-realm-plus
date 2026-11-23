import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { translateRisuRegex, bodyForSt } from '../server/regex-translate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const mk = (over = {}) => ({ comment: 'S', in: 'a', out: 'b', type: 'editoutput', ableFlag: false, flag: '', ...over });
const one = (over) => translateRisuRegex([mk(over)]);
const reasons = (res) => res.report.lossy.flatMap(l => l.reasons);

// the ST engine of the user's Regex extension, only if present on this machine
const ENGINE = path.join(os.homedir(), 'ProjectSigma-main/extensions/installed/regex/client/core/engine.js');
const engine = fs.existsSync(ENGINE) ? await import(pathToFileURL(ENGINE).href) : null;
const stParse = (s) => {
    const m = s.match(/(\/?)(.+)\1([a-z]*)/i);
    return new RegExp(m[2], m[3]);
};

test('non-array input and malformed entries never throw', () => {
    for (const bad of [undefined, null, 'x', 5, {}]) {
        assert.deepEqual(translateRisuRegex(bad), { scripts: [], report: { translated: 0, lossy: [], skipped: [], off: [] } });
    }
    const r = translateRisuRegex([null, 'x', [], mk({ in: 5 }), mk({ out: undefined }), mk({ type: undefined })]);
    assert.equal(r.scripts.length, 0);
    assert.equal(r.report.skipped.length, 6);
    assert.equal(r.report.skipped[0].name, 'Risu script 1');
});

test('types map to placement and mode', () => {
    const shape = (type) => { const s = one({ type }).scripts[0]; return [s.placement, s.markdownOnly, s.promptOnly, s.disabled]; };
    assert.deepEqual(shape('editinput'), [[1], false, false, false]);
    assert.deepEqual(shape('editoutput'), [[2], false, false, false]);
    assert.deepEqual(shape('editdisplay'), [[1, 2], true, false, false]);
    assert.deepEqual(shape('editprocess'), [[1, 2], false, true, false]);
});

test('disabled, edittrans, unknown type and empty pattern are skipped with a reason', () => {
    for (const over of [{ type: 'disabled' }, { type: 'edittrans' }, { type: 'weird' }, { in: '' }]) {
        const r = one(over);
        assert.equal(r.scripts.length, 0);
        assert.equal(r.report.skipped.length, 1);
        assert.ok(r.report.skipped[0].reason);
    }
});

test('flags: ableFlag off is g, on uses flag, junk drops, empty is u', () => {
    const f = (o) => one(o).scripts[0].findRegex.split('/').pop();
    assert.equal(f({ ableFlag: false, flag: 'i' }), 'g');
    assert.equal(f({ ableFlag: true, flag: 'gi' }), 'gi');
    assert.equal(f({ ableFlag: true, flag: '' }), 'g');
    assert.equal(f({ ableFlag: true, flag: 'iigx' }), 'ig');
    assert.equal(f({ ableFlag: true, flag: 'x' }), 'u');
    assert.equal(f({ ableFlag: true, flag: '<order 1>' }), 'g');
});

test('flag d is dropped quietly, v becomes u with a reason, y is skipped, bad v is skipped', () => {
    const d = one({ ableFlag: true, flag: 'dg' });
    assert.equal(d.scripts[0].findRegex, '/a/g');
    assert.equal(d.report.lossy.length, 0);
    const v = one({ ableFlag: true, flag: 'gv' });
    assert.equal(v.scripts[0].findRegex, '/a/gu');
    assert.match(reasons(v)[0], /flag v/);
    assert.match(one({ ableFlag: true, flag: 'gy' }).report.skipped[0].reason, /sticky/);
    // [\p{L}--[a-z]] only compiles under v
    assert.match(one({ in: '[\\p{L}--[a-z]]', ableFlag: true, flag: 'v' }).report.skipped[0].reason, /does not compile as u/);
    // u and v together do not compile in Risu either
    assert.match(one({ ableFlag: true, flag: 'uv' }).report.skipped[0].reason, /does not compile/);
});

test('a pattern that does not compile is skipped', () => {
    assert.match(one({ in: '(' }).report.skipped[0].reason, /does not compile/);
});

test('slashes and line breaks are escaped and read back by the ST parser', () => {
    const r = one({ in: 'a/b[/]\\/c\nd', ableFlag: true, flag: 'g' });
    const find = r.scripts[0].findRegex;
    assert.equal(find, '/a\\/b[\\/]\\/c\\nd/g');
    const re = stParse(find);
    assert.equal(re.test('a/b//c\nd'), true);
    assert.equal(bodyForSt('x/y'), 'x\\/y');
    if (engine) assert.equal(engine.regexFromString(find).source, re.source);
});

test('replacement: $&, {{data}}, groups and $n', () => {
    assert.equal(one({ in: '(a)', out: '[$&|$1]' }).scripts[0].replaceString, '[$0|$1]');
    const d = one({ out: '<{{data}}>' });
    assert.equal(d.scripts[0].replaceString, '<$0>\n');
    assert.ok(reasons(d).some(x => x.includes('{{data}}')));
    assert.equal(one({ out: 'a$nb' }).scripts[0].replaceString, 'a\nb');
    assert.equal(one({ in: '(a)(b)', out: '$2$1' }).scripts[0].replaceString, '$2$1');
});

test('replacement edge cases', () => {
    assert.equal(one({ out: 'a$$b' }).scripts[0].replaceString, 'a$b');
    assert.match(one({ out: '$$1' }).report.skipped[0].reason, /\$\$/);
    assert.match(one({ out: "x$'" }).report.skipped[0].reason, /cannot express/);
    assert.match(one({ out: '$0' }).report.skipped[0].reason, /\$0/);
    assert.ok(reasons(one({ in: '(a)', out: '$2' })).some(x => x.includes('lacks')));
    assert.equal(one({ in: '(a)', out: '$01' }).scripts[0].replaceString, '$1');
});

test('trailing > gets a newline unless no_end_nl', () => {
    assert.equal(one({ out: '<br>' }).scripts[0].replaceString, '<br>\n');
    assert.equal(one({ out: '<br>', ableFlag: true, flag: 'g<no_end_nl>' }).scripts[0].replaceString, '<br>');
});

test('@@ directives and move/inject/repeat actions are skipped', () => {
    for (const out of ['@@emo happy', '@@inject', '@@move_top x', '@@move_bottom x', '@@repeat_back end']) {
        assert.equal(one({ out }).scripts.length, 0, out);
    }
    for (const a of ['inject', 'move_top', 'move_bottom', 'repeat_back']) {
        assert.equal(one({ ableFlag: true, flag: `g<${a}>` }).scripts.length, 0, a);
    }
    // an unknown @@ is pasted as text in Risu too
    assert.equal(one({ out: '@@zzz' }).scripts.length, 1);
});

test('<cbs> patterns: supported macros use raw substitution, others are skipped', () => {
    const ok = one({ in: '{{user}}:', ableFlag: true, flag: 'g<cbs>' });
    assert.equal(ok.scripts[0].substituteRegex, 1);
    assert.equal(ok.scripts[0].findRegex, '/{{user}}:/g');
    assert.equal(one({ in: '{{user}}:' }).scripts[0].substituteRegex, 0);
    assert.match(one({ in: '{{random::a::b}}', ableFlag: true, flag: 'g<cbs>' }).report.skipped[0].reason, /macros/);
    assert.equal(one({ in: 'a', ableFlag: true, flag: 'g<cbs>' }).scripts[0].substituteRegex, 0);
});

test('CBS in out is kept with a precise reason', () => {
    const r = one({ out: '{{user}} {{#if {{getvar::x}}}}y{{/if}} {{Get_Var::z}} <user>' });
    assert.equal(r.scripts.length, 1);
    const text = reasons(r).join(' | ');
    assert.match(text, /\{\{#if\}\}/);
    assert.match(text, /\{\{\/if\}\}/);
    assert.doesNotMatch(text, /\{\{user\}\}/);
    assert.doesNotMatch(text, /getvar/);
    assert.match(text, /<user>/);
    assert.equal(reasons(one({ out: '{{user}} {{char}}' })).length, 0);
    assert.ok(reasons(one({ out: '<style>.a{}</style>' })).some(x => x.includes('style')));
});

test('<order N> sorts descending, stable, and is reported', () => {
    const r = translateRisuRegex([
        mk({ comment: 'a' }),
        mk({ comment: 'b', ableFlag: true, flag: 'g<order 2>' }),
        mk({ comment: 'c' }),
        mk({ comment: 'd', ableFlag: true, flag: 'g<order 9>' }),
    ]);
    assert.deepEqual(r.scripts.map(s => s.scriptName), ['d', 'b', 'a', 'c']);
    assert.deepEqual(r.report.lossy.map(l => l.name).sort(), ['b', 'd']);
    // without any order the source order stays
    assert.deepEqual(translateRisuRegex([mk({ comment: 'x' }), mk({ comment: 'y' })]).scripts.map(s => s.scriptName), ['x', 'y']);
    // order is ignored when ableFlag is off
    assert.equal(one({ flag: 'g<order 3>' }).report.lossy.length, 0);
});

test('scriptName falls back to a stable number and ids are deterministic', () => {
    const list = [mk({ comment: '' }), mk({ comment: 'Named' }), mk({ comment: undefined, in: 'z' })];
    const a = translateRisuRegex(list);
    const b = translateRisuRegex(JSON.parse(JSON.stringify(list)));
    assert.deepEqual(a.scripts.map(s => s.scriptName), ['Risu script 1', 'Named', 'Risu script 3']);
    assert.deepEqual(a.scripts.map(s => s.id), b.scripts.map(s => s.id));
    assert.equal(new Set(a.scripts.map(s => s.id)).size, 3);
    assert.match(a.scripts[0].id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // identical scripts at other positions differ; an edit changes the id
    const twin = translateRisuRegex([mk(), mk()]).scripts;
    assert.notEqual(twin[0].id, twin[1].id);
    assert.notEqual(one({ out: 'c' }).scripts[0].id, one().scripts[0].id);
});

test('output is accepted by the Regex extension normalizeScript', { skip: !engine && 'regex extension not on this machine' }, () => {
    const fixture = JSON.parse(fs.readFileSync(path.join(here, 'fixtures/regex/sample-module-regex.json'), 'utf8'));
    for (const s of translateRisuRegex(fixture).scripts) {
        assert.deepEqual(engine.normalizeScript(s), s);
        assert.equal(engine.isScript(s), true);
        assert.ok(engine.regexFromString(s.findRegex) instanceof RegExp);
    }
});

test('a hand-written module translates as a whole', () => {
    const fixture = JSON.parse(fs.readFileSync(path.join(here, 'fixtures/regex/sample-module-regex.json'), 'utf8'));
    const r = translateRisuRegex(fixture);
    assert.equal(r.report.translated, 6);
    assert.deepEqual(r.scripts.map(s => s.scriptName), ['Late rule', 'Fix ellipses', 'Strip OOC', 'Status box', 'Hide notes from prompt', 'Wave']);
    assert.deepEqual(r.report.skipped.map(s => s.name), ['Mood tag', 'Unused']);
    assert.deepEqual(r.report.lossy.map(l => l.name), ['Late rule', 'Wave']);
    const status = r.scripts.find(s => s.scriptName === 'Status box');
    assert.equal(status.findRegex, '/\\[status\\](.+?)\\[\\/status\\]/gs');
    assert.equal(status.replaceString, '<div class="box">$1</div>\n');
    assert.equal(status.markdownOnly, true);
    // run the produced entry against sample text, the way ST would
    assert.equal('x [status]hi[/status]'.replace(stParse(status.findRegex), '<$1>'), 'x <hi>');
});

test('a script whose output needs CBS goes on the card switched off, and is reported', () => {
    const r = translateRisuRegex([
        mk({ comment: 'needs', out: '<img src="{{raw::$1}}">' }),
        mk({ comment: 'st-only', out: '{{user}} and {{char}}' }),
        mk({ comment: 'plain', out: 'b' }),
    ]);
    assert.deepEqual(r.scripts.map(s => [s.scriptName, s.disabled]), [['needs', true], ['st-only', false], ['plain', false]]);
    assert.equal(r.report.translated, 3);
    assert.deepEqual(r.report.off.map(o => o.name), ['needs']);
    assert.match(r.report.off[0].reason, /\{\{raw\}\}/);
});
