import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildDeb, inspectDeb } from '../../scripts/build-deb.mjs';

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, '../..');
const preflightPath = resolve(root, 'packaging/deb/r7-ai-assistant-preflight');
const declarationPath = resolve(root, 'packaging/compatibility.json');

async function runPreflight(env) {
  try {
    const shell = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\sh.exe' : '/bin/sh';
    const result = await execFileAsync(shell, [preflightPath], { env: { ...process.env, R7_AI_PYTHON: process.platform === 'win32' ? 'python' : 'python3', ...env }, encoding: 'utf8' });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

async function fixture(tuple, astra = { version: '1.7.9', buildVersion: '1.7.9.41' }, versionStream = 'stdout') {
  const directory = await mkdtemp(join(tmpdir(), 'r7-preflight-'));
  const dpkgQuery = join(directory, 'dpkg-query');
  const desktopEditors = join(directory, 'DesktopEditors');
  const astraVersion = join(directory, 'astra_version');
  const astraBuildVersion = join(directory, 'build_version');
  await writeFile(dpkgQuery, `#!/bin/sh\nprintf '%s\\t%s\\t%s\\n' '${tuple.package}' '${tuple.packageVersion}' '${tuple.architecture}'\n`);
  const redirect = versionStream === 'stderr' ? ' >&2' : '';
  await writeFile(desktopEditors, `#!/bin/sh\nprintf '%s\\n' 'diagnostic without version'\nprintf '%s\\n' 'Р7-Офис ver. ${tuple.productVersion}'${redirect}\n`);
  await writeFile(astraVersion, `${astra.version}\n`);
  await writeFile(astraBuildVersion, `${astra.buildVersion}\n`);
  await chmod(dpkgQuery, 0o755); await chmod(desktopEditors, 0o755);
  return {
    R7_AI_DPKG_QUERY: dpkgQuery,
    R7_AI_DESKTOP_EDITORS: desktopEditors,
    R7_AI_ASTRA_VERSION_FILE: astraVersion,
    R7_AI_ASTRA_BUILD_VERSION_FILE: astraBuildVersion
  };
}

test('shipped preflight consumes the plugin compatibility declaration and accepts its exact tuple', async () => {
  const declaration = JSON.parse(await readFile(declarationPath, 'utf8'));
  const result = await runPreflight({ ...(await fixture(declaration.compatibility.r7)), R7_AI_COMPATIBILITY: declarationPath });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /SUPPORTED exact target/);
});

test('shipped preflight parses the first version-bearing line when DesktopEditors writes it to stderr', async () => {
  const declaration = JSON.parse(await readFile(declarationPath, 'utf8'));
  const result = await runPreflight({ ...(await fixture(declaration.compatibility.r7, undefined, 'stderr')), R7_AI_COMPATIBILITY: declarationPath });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`${declaration.compatibility.r7.productVersion}$`, 'm'));
});

test('shipped preflight refuses mismatching Astra version or build before invoking activation', async () => {
  const declaration = JSON.parse(await readFile(declarationPath, 'utf8'));
  for (const astra of [
    { version: '1.8.0', buildVersion: declaration.compatibility.astra.buildVersion },
    { version: declaration.compatibility.astra.version, buildVersion: '1.7.9.99' }
  ]) {
    const directory = await mkdtemp(join(tmpdir(), 'r7-refusal-'));
    const marker = join(directory, 'activation-ran');
    const activate = join(directory, 'activate');
    await writeFile(activate, `#!/bin/sh\nprintf touched > '${marker}'\n`); await chmod(activate, 0o755);
    const result = await runPreflight({ ...(await fixture(declaration.compatibility.r7, astra)), R7_AI_COMPATIBILITY: declarationPath, R7_AI_ACTIVATE: activate });
    assert.equal(result.code, 42);
    assert.match(result.stderr, /REFUSED unsupported target: Astra (version|build)/);
    await assert.rejects(readFile(marker), /ENOENT/);
  }
});

test('shipped preflight refuses an unsupported R7 target before invoking activation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'r7-refusal-'));
  const marker = join(directory, 'activation-ran');
  const activate = join(directory, 'activate');
  await writeFile(activate, `#!/bin/sh\nprintf touched > '${marker}'\n`); await chmod(activate, 0o755);
  const result = await runPreflight({ ...(await fixture({ package: 'r7-office', packageVersion: '2026.3.1-9999~astra-signed', architecture: 'amd64', productVersion: '2026.3.1.9999' })), R7_AI_COMPATIBILITY: declarationPath, R7_AI_ACTIVATE: activate });
  assert.equal(result.code, 42);
  assert.match(result.stderr, /REFUSED unsupported target/);
  await assert.rejects(readFile(marker), /ENOENT/);
});

test('DEB ships the declaration and executable preflight as inert data', async () => {
  const result = await buildDeb();
  const deb = inspectDeb(await readFile(result.debPath));
  assert.ok(deb.data['usr/share/r7-ai-assistant/compatibility.json']);
  assert.deepEqual(deb.data['usr/bin/r7-ai-assistant-preflight'], await readFile(preflightPath));
});
