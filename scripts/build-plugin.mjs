import { build, version } from 'esbuild';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { auditSource } from './static-audit.mjs';
import { zipStore } from './zip-store.mjs';
import { iconPng } from './icon-assets.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const execFileAsync = promisify(execFile);
const PRODUCT_VERSION = '0.9.0-pilot-rc.1';
const PAYLOAD_FILES = Object.freeze(['LICENSE', 'THIRD_PARTY_NOTICES.md', 'config.json', 'index.html', 'panel.js', 'resources/icon.png', 'resources/icon@2x.png', 'styles.css']);
export const RELEASE_FILES = Object.freeze([...PAYLOAD_FILES, 'provenance.json'].sort());
const publicCopies = Object.freeze([
  ['LICENSE', 'LICENSE'], ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'],
  ['config.json', 'src/plugin/config.json'], ['index.html', 'src/ui/index.html'], ['styles.css', 'src/ui/styles.css']
]);
function invalid() { throw new Error('INVALID_BUILD_INPUT'); }
function sha256(data) { return createHash('sha256').update(data).digest('hex'); }
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export async function buildPlugin(options = {}) {
  if (!options || Reflect.ownKeys(options).some(key => !['output', 'esbuildVersion'].includes(key))) invalid();
  const output = options.output ?? 'dist/plugin';
  if (typeof output !== 'string' || !/^dist\/[A-Za-z0-9_-]+$/.test(output)) invalid();
  if ((options.esbuildVersion ?? version) !== '0.25.10' || version !== '0.25.10') throw new Error('UNPINNED_BUILD_TOOL');
  const destination = resolve(root, output);
  // Check real paths before writing: an ignored directory must not redirect into
  // source/private state via a symlink. No arbitrary outputs/copy inventories.
  await mkdir(resolve(root, 'dist'), { recursive: true });
  if (await realpath(resolve(root, 'dist')) !== resolve(root, 'dist')) invalid();
  await mkdir(destination, { recursive: true });
  if (await realpath(destination) !== destination) invalid();
  const bundle = await build({ absWorkingDir: root, entryPoints: ['src/ui/entry.js'], outfile: 'panel.js',
    bundle: true, write: false, platform: 'browser', format: 'iife', target: 'es2022', charset: 'utf8',
    minify: false, treeShaking: true, sourcemap: false, legalComments: 'none', metafile: true, logLevel: 'silent' });
  for (const input of Object.keys(bundle.metafile.inputs)) {
    const path = relative(resolve(root, 'src'), resolve(root, input));
    if (isAbsolute(path) || path.startsWith('..') || !path.endsWith('.js')) invalid();
  }
  if (bundle.outputFiles.length !== 1) invalid();
  const browserSource = bundle.outputFiles[0].text;
  if (auditSource(browserSource, 'panel.js').length !== 0) throw new Error('BUNDLE_AUDIT_FAILED');
  const entries = [];
  for (const [name, source] of publicCopies) entries.push({ name, data: await readFile(resolve(root, source)) });
  entries.push({ name: 'panel.js', data: Buffer.from(browserSource, 'utf8') },
    { name: 'resources/icon.png', data: iconPng(32) }, { name: 'resources/icon@2x.png', data: iconPng(64) });
  const payloadNames = entries.map(entry => entry.name).sort();
  if (JSON.stringify(payloadNames) !== JSON.stringify(PAYLOAD_FILES)) invalid();
  const { stdout: commitOutput } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  const sourceCommit = commitOutput.trim();
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) invalid();
  const files = Object.fromEntries(entries.slice().sort((a, b) => a.name.localeCompare(b.name)).map(entry => [entry.name, { sha256: sha256(entry.data) }]));
  const declaration = JSON.parse(await readFile(resolve(root, 'packaging/compatibility.json'), 'utf8'));
  const provenance = {
    compatibility: declaration.compatibility,
    files,
    productVersion: PRODUCT_VERSION,
    sourceCommit,
    toolchain: { esbuild: version, node: process.version }
  };
  entries.push({ name: 'provenance.json', data: Buffer.from(`${stableJson(provenance)}\n`, 'utf8') });
  const names = entries.map(entry => entry.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(RELEASE_FILES)) invalid();
  // Never enumerate/copy a repository, tests, ignored configuration or installed SDK.
  for (const entry of entries) {
    const path = resolve(destination, entry.name);
    await mkdir(dirname(path), { recursive: true });
    if (await realpath(dirname(path)) !== dirname(path)) invalid();
    // Existing files must be ordinary regular files, not output symlinks.
    try { if (await realpath(path) !== path) invalid(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await writeFile(path, entry.data);
  }
  const archive = zipStore(entries);
  const zipPath = resolve(destination, 'r7-ai-assistant.zip'); const pluginPath = resolve(destination, 'r7-ai-assistant.plugin');
  for (const path of [zipPath, pluginPath]) {
    try { if (await realpath(path) !== path) invalid(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await writeFile(path, archive);
  }
  const archiveSha256 = sha256(archive);
  return Object.freeze({ archive, zipPath, pluginPath, sha256: archiveSha256, files: RELEASE_FILES });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildPlugin();
  process.stdout.write(`Plugin build: ${result.files.length} allowlisted files; ZIP STORE SHA-256 ${result.sha256}\n`);
}
