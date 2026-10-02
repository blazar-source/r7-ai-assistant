import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditSource, auditPaths } from '../../scripts/static-audit.mjs';

// ALL adversarial fixtures are parser inputs only. Never execute/evaluate/import them.
const forbidden = [
  ['eval("fixture")', 'DYNAMIC_EXECUTION'],
  ['eval?.("fixture")', 'DYNAMIC_EXECUTION'],
  ['(0, eval)("fixture")', 'DYNAMIC_EXECUTION'],
  ['const e = eval; e("fixture")', 'DYNAMIC_EXECUTION'],
  ['const e = globalThis.eval; e("fixture")', 'DYNAMIC_EXECUTION'],
  ['window["eval"]("fixture")', 'DYNAMIC_EXECUTION'],
  ['self["ev" + "al"]("fixture")', 'DYNAMIC_EXECUTION'],
  ['globalThis[`eval`]("fixture")', 'DYNAMIC_EXECUTION'],
  ['const { eval: e } = window; e("fixture")', 'DYNAMIC_EXECUTION'],
  ['const name = "eval"; window[name]("fixture")', 'DYNAMIC_PROPERTY'],
  ['const g = globalThis; const n = "eval"; const e = g[n]; e("fixture")', 'DYNAMIC_PROPERTY'],
  ['Function("fixture")()', 'DYNAMIC_EXECUTION'],
  ['new Function("fixture")', 'DYNAMIC_EXECUTION'],
  ['const F = window["Function"]; new F("fixture")', 'DYNAMIC_EXECUTION'],
  ['const { Function: F } = globalThis; F("fixture")', 'DYNAMIC_EXECUTION'],
  ['(() => {}).constructor("fixture")()', 'DYNAMIC_EXECUTION'],
  ['const f = {}["constructor"]["constructor"]; f("fixture")()', 'DYNAMIC_EXECUTION'],
  ['const c = "con" + "structor"; (()=>{})[c]("fixture")', 'DYNAMIC_PROPERTY'],
  ['Reflect.get(window, "eval")("fixture")', 'DYNAMIC_EXECUTION'],
  ['Reflect.apply(sink, null, ["fixture"])', 'DYNAMIC_EXECUTION'],
  ['Reflect.construct(factory, ["fixture"])', 'DYNAMIC_EXECUTION'],
  ['setTimeout("fixture", 10)', 'DYNAMIC_TIMER'],
  ['window.setInterval(`fixture`, 10)', 'DYNAMIC_TIMER'],
  ['const timer = setTimeout; timer("fixture", 10)', 'DYNAMIC_TIMER'],
  ['setTimeout(callback, 10)', 'DYNAMIC_TIMER'],
  ['Asc.plugin.callCommand(modelText)', 'NON_STATIC_COMMAND'],
  ['Asc.plugin.callCommand("fixture")', 'NON_STATIC_COMMAND'],
  ['Asc.plugin.callCommand(command)', 'NON_STATIC_COMMAND'],
  ['Asc.plugin["callCommand"](command)', 'NON_STATIC_COMMAND'],
  ['Asc.plugin.callCommand?.(command)', 'NON_STATIC_COMMAND'],
  ['const run = Asc.plugin.callCommand; run(command)', 'NON_STATIC_COMMAND'],
  ['const {callCommand: run} = Asc.plugin; run(command)', 'NON_STATIC_COMMAND'],
  ['Asc.plugin.callCommand(async function(){})', 'NON_STATIC_COMMAND'],
  ['Asc.plugin.callCommand(function*(){})', 'NON_STATIC_COMMAND'],
  ['import(modelText)', 'DYNAMIC_EXECUTION'],
  ['obj[k](source)', 'DYNAMIC_PROPERTY'],
  ['obj[k]?.(source)', 'DYNAMIC_PROPERTY'],
  ['new obj[k](source)', 'DYNAMIC_PROPERTY'],
  ['const run = obj[k]; run(source)', 'DYNAMIC_PROPERTY'],
  ['let run; run = obj[k]; const next = run; next(source)', 'DYNAMIC_PROPERTY'],
  ['const run = obj[k]; run.call(null, source)', 'DYNAMIC_PROPERTY'],
  ['const run = obj[k].bind(null); run(source)', 'DYNAMIC_PROPERTY'],
  ['const { [k]: run } = obj; run(source)', 'DYNAMIC_PROPERTY'],
  ['const [run] = obj[k]; run(source)', 'DYNAMIC_PROPERTY'],
  ['const run = flag ? obj[k] : safe; run(source)', 'DYNAMIC_PROPERTY'],
  ['const run = (0, obj[k]); run(source)', 'DYNAMIC_PROPERTY'],
  ['const value = globalThis[k]; consume(value)', 'DYNAMIC_PROPERTY'],
  ['const holder = { run: obj[k] }; holder.run(source)', 'DYNAMIC_PROPERTY'],
  ['const holder = [obj[k]]; holder[0](source)', 'DYNAMIC_PROPERTY'],
  ['const holder = {}; holder.run = obj[k]; holder.run(source)', 'DYNAMIC_PROPERTY'],
  ['const run = obj[k]; run`source`', 'DYNAMIC_PROPERTY'],
  ['function execute(run = obj[k]) { run(source); }', 'DYNAMIC_PROPERTY'],
  ['function execute({[k]: run}) { run(source); }', 'DYNAMIC_PROPERTY'],
  ['const {"eval": e} = holder; e("fixture")', 'DYNAMIC_EXECUTION'],
  ['const {"constructor": C} = holder; C("fixture")', 'DYNAMIC_EXECUTION'],
  ['const {"callCommand": run} = holder; run(command)', 'NON_STATIC_COMMAND'],
  ['Object.getOwnPropertyDescriptor(holder, "eval").value("fixture")', 'DYNAMIC_EXECUTION'],
  ['Object.getOwnPropertyDescriptor(holder, name).value("fixture")', 'DYNAMIC_PROPERTY'],
  ['const descriptor = Object.getOwnPropertyDescriptor; descriptor(holder, "eval").value("fixture")', 'DYNAMIC_EXECUTION']
];
for (const [source, code] of forbidden) {
  test(`inert guard rejects ${source}`, () => {
    const findings = auditSource(source, 'fixture.js');
    assert.ok(findings.some(finding => finding.code === code), `missing ${code}`);
    assert.ok(findings.every(finding => finding.label === 'fixture.js' && Number.isInteger(finding.line) && finding.line >= 1 && Number.isInteger(finding.column)));
  });
}
for (const source of [
  'Asc.scope.input = { text: "synthetic" }; Asc.plugin.callCommand(function () { const text = Asc.scope.input.text; Api.GetDocument(); });',
  'Asc.plugin["callCommand"](function () { Api.GetDocument(); });',
  'setTimeout(() => { finish(); }, 10); window.setInterval(function () { tick(); }, 10);',
  'const text = "eval(never executed)"; // Function(also inert)\nJSON.parse(text);',
  'const index = ["ok"][0]; const obj = { safe: true }; obj.safe;',
  'const row = array[i]; consume(row.text); const value = dictionary[field]; JSON.stringify(value); const byte = buffer[offset];',
  'const { [field]: value } = dictionary; consume(value); const record = { [field]: value }; consume(record);',
  'for (let i = 0; i < bytes.length; i++) { total += bytes[i]; }',
  'class Settings { constructor(value) { this.value = value; } }',
  'import { parse } from "acorn"; export function read(text) { return parse(text); }'
]) {
  test(`guard allows authored static fixture ${source.slice(0, 32)}`, () => assert.deepEqual(auditSource(source, 'safe.js'), []));
}

// Regression: removing reflected-result taint must reject these parser-only
// compilation shapes, without invoking any function or model text.
for (const [name, source] of [
  ['exact review reproducer', 'const factory = Object.values(Object.getOwnPropertyDescriptors(Object.getPrototypeOf(async function () {})))[0].value; factory(modelText)();'],
  ['direct bulk descriptor execution', 'Object.getOwnPropertyDescriptors(proto).safe.value(modelText)();'],
  ['constant computed bulk property', 'const factory = Object["getOwnProperty" + "Descriptors"](proto).safe.value; factory(modelText)();'],
  ['aliased descriptor and aggregation results', 'const descriptors = Object.getOwnPropertyDescriptors(proto); const values = Object.values(descriptors); const factory = values[0].value; factory(modelText)();'],
  ['immediate aggregation execution', 'Object.values(Object.getOwnPropertyDescriptors(proto))[0].value(modelText)();'],
  ['entries aggregation execution', 'const factory = Object.entries(Object.getOwnPropertyDescriptors(proto))[0][1].value; factory(modelText)();'],
  ['indirect aggregation execution', 'const collect = Object.values; const factory = collect(Object.getOwnPropertyDescriptors(proto))[0].value; factory(modelText)();'],
  ['extracted bulk descriptor method', 'const describe = Object.getOwnPropertyDescriptors; const factory = Object.values(describe(proto))[0].value; factory(modelText)();']
]) {
  test(`inert guard rejects reflected compilation: ${name}`, () => {
    const findings = auditSource(source, 'reflected-fixture.js');
    assert.ok(findings.some(finding => ['DYNAMIC_EXECUTION', 'DYNAMIC_PROPERTY'].includes(finding.code)), `missing classified finding; got ${JSON.stringify(findings)}`);
    assert.ok(findings.every(finding => finding.label === 'reflected-fixture.js'));
  });
}

for (const [name, source] of [
  ['single descriptor DATA validation', 'const length = Object.getOwnPropertyDescriptor(value, "length"); if (!length || !Object.hasOwn(length, "value") || length.enumerable || typeof length.value !== "number") invalid();'],
  ['prototype DATA validation', 'if (!raw || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) invalid();'],
  ['bulk descriptor DATA presence check', 'const descriptor = Object.getOwnPropertyDescriptors(object)[name]; const present = !!descriptor && typeof descriptor.value === "function";'],
  ['immediate aggregated DATA validation', 'for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(raw))) { if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) invalid(); }'],
  ['aliased aggregated DATA inspection', 'const descriptors = Object.getOwnPropertyDescriptors(raw); const values = Object.values(descriptors); const descriptor = values[0]; const present = typeof descriptor.value === "boolean";'],
  ['quoted bulk descriptor name', 'const text = "Object.getOwnPropertyDescriptors(proto)"; JSON.parse(text);']
]) {
  test(`guard preserves descriptor DATA: ${name}`, () => assert.deepEqual(auditSource(source, 'descriptor-data.js'), []));
}

test('parse failures have safe code/location, never raw parser/source message', () => {
  const result = auditSource('const synthetic_private_value = ;', 'bad.js');
  assert.equal(result.length, 1);
  assert.equal(result[0].code, 'PARSE_ERROR');
  assert.equal(result[0].line, 1);
  assert.ok(!JSON.stringify(result).includes('synthetic_private_value'));
});

test('directory audit includes authored plugin/scripts/bundles and ignores inert test strings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'r7-authored-audit-'));
  try {
    for (const directory of ['src/plugin', 'scripts', 'dist', 'tests/security', 'node_modules/vendor']) await mkdir(join(root, directory), { recursive: true });
    await writeFile(join(root, 'src/plugin/unsafe.js'), forbidden[0][0]);
    await writeFile(join(root, 'scripts/unsafe.mjs'), forbidden[11][0]);
    await writeFile(join(root, 'dist/bundle.js'), forbidden[25][0]);
    await writeFile(join(root, 'tests/security/inert.test.js'), `const fixture = ${JSON.stringify(forbidden[0][0])};`);
    await writeFile(join(root, 'node_modules/vendor/unsafe.js'), forbidden[0][0]);
    const result = await auditPaths(root);
    assert.deepEqual(new Set(result.map(f => f.label)), new Set(['src/plugin/unsafe.js', 'scripts/unsafe.mjs', 'dist/bundle.js']));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('default inventory suppresses only absent paths, not invalid-root I/O errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'r7-invalid-audit-root-'));
  try {
    const file = join(root, 'not-a-directory');
    await writeFile(file, 'inert data');
    const result = await auditPaths(file);
    assert.ok(result.some(f => f.code === 'READ_ERROR'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('explicit bundle paths are audited and missing explicit input fails closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'r7-bundle-audit-'));
  try {
    await writeFile(join(root, 'other.js'), forbidden[0][0]);
    assert.ok((await auditPaths(root, ['other.js'])).some(f => f.code === 'DYNAMIC_EXECUTION'));
    assert.equal((await auditPaths(root, ['missing.js']))[0]?.code, 'READ_ERROR');
  } finally { await rm(root, { recursive: true, force: true }); }
});
