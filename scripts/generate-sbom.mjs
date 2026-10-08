import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPlugin } from './build-plugin.mjs';
import { inventory } from '../tests/fixtures/archive.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const PRODUCT_VERSION = '0.9.0-pilot-rc';
function sha256(data) { return createHash('sha256').update(data).digest('hex'); }
function invalid() { throw new Error('INVALID_SBOM_INPUT'); }
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function fileId(name) { return `SPDXRef-File-${name.replace(/[^A-Za-z0-9.-]/g, '-')}`; }

export async function generateSbom(options = {}) {
  if (!options || Reflect.ownKeys(options).some(key => !['archive', 'output'].includes(key))) invalid();
  const archive = options.archive;
  if (!Buffer.isBuffer(archive)) invalid();
  const output = options.output ?? 'dist/r7-ai-assistant.spdx.json';
  if (typeof output !== 'string' || !/^dist\/[A-Za-z0-9_.\/-]+\.spdx\.json$/.test(output) || output.includes('..')) invalid();
  const entries = inventory(archive);
  const names = entries.map(entry => entry.name);
  const provenance = JSON.parse(entries.find(entry => entry.name === 'provenance.json')?.data.toString('utf8') ?? 'null');
  if (!provenance || provenance.productVersion !== PRODUCT_VERSION || provenance.toolchain?.node !== process.version || provenance.toolchain?.esbuild !== '0.25.10') invalid();
  for (const [name, detail] of Object.entries(provenance.files)) {
    const entry = entries.find(item => item.name === name);
    if (!entry || sha256(entry.data) !== detail.sha256) throw new Error('PROVENANCE_PAYLOAD_MISMATCH');
  }
  const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8'));
  const runtimeLocked = Object.entries(lock.packages).filter(([name, item]) => name && item.dev !== true);
  if (Object.keys(packageJson.dependencies ?? {}).length || Object.keys(lock.packages[''].dependencies ?? {}).length || runtimeLocked.length) throw new Error('RUNTIME_DEPENDENCIES_PRESENT');
  const panel = entries.find(entry => entry.name === 'panel.js')?.data.toString('utf8') ?? '';
  if (/(?:node_modules|require\s*\(|from\s+['"](?![./])|import\s*\(['"](?![./]))/.test(panel)) throw new Error('EXTERNAL_RUNTIME_MODULE_IN_BUNDLE');
  const files = entries.slice().sort((a, b) => a.name.localeCompare(b.name)).map(entry => ({
    SPDXID: fileId(entry.name),
    checksums: [{ algorithm: 'SHA256', checksumValue: sha256(entry.data) }],
    copyrightText: 'Copyright (c) R7 AI Assistant rights holder. All Rights Reserved.',
    fileName: `./${entry.name}`,
    licenseConcluded: entry.name === 'THIRD_PARTY_NOTICES.md' ? 'LicenseRef-Proprietary AND MIT' : 'LicenseRef-Proprietary',
    licenseInfoInFiles: entry.name === 'THIRD_PARTY_NOTICES.md' ? ['LicenseRef-Proprietary', 'MIT'] : ['LicenseRef-Proprietary']
  }));
  const document = {
    SPDXID: 'SPDXRef-DOCUMENT',
    annotations: [{
      annotationComment: 'CHECKED: zero runtime dependencies; package.json has no dependencies, package-lock root has no dependencies and all locked non-root packages are dev-only, and packaged panel.js has no external module imports or CommonJS require calls.',
      annotationDate: '1970-01-01T00:00:00Z', annotationType: 'OTHER', annotator: 'Tool: scripts/generate-sbom.mjs'
    }],
    creationInfo: { created: '1970-01-01T00:00:00Z', creators: ['Tool: scripts/generate-sbom.mjs'], licenseListVersion: '3.25' },
    dataLicense: 'CC0-1.0',
    documentNamespace: `https://r7-ai-assistant.invalid/spdx/${PRODUCT_VERSION}/${sha256(archive)}`,
    files,
    hasExtractedLicensingInfos: [{ extractedText: 'Standalone commercial product. All Rights Reserved; no license grant is made.', licenseId: 'LicenseRef-Proprietary', name: 'R7 AI Assistant proprietary license' }],
    name: `r7-ai-assistant-${PRODUCT_VERSION}`,
    packages: [
      { SPDXID: 'SPDXRef-Package-R7AIAssistant', checksums: [{ algorithm: 'SHA256', checksumValue: sha256(archive) }], copyrightText: 'Copyright (c) R7 AI Assistant rights holder. All Rights Reserved.', downloadLocation: 'NOASSERTION', filesAnalyzed: true, licenseConcluded: 'LicenseRef-Proprietary', licenseDeclared: 'LicenseRef-Proprietary', name: 'r7-ai-assistant', packageFileName: 'r7-ai-assistant.zip', primaryPackagePurpose: 'APPLICATION', supplier: 'Organization: R7 AI Assistant', versionInfo: PRODUCT_VERSION, packageVerificationCode: { packageVerificationCodeValue: sha256(Buffer.from(files.map(file => file.checksums[0].checksumValue).sort().join(''), 'ascii')) } },
      { SPDXID: 'SPDXRef-BuildTool-Node', copyrightText: 'Copyright Node.js contributors. MIT License.', downloadLocation: 'https://nodejs.org/', filesAnalyzed: false, licenseConcluded: 'MIT', licenseDeclared: 'MIT', name: 'Node.js', primaryPackagePurpose: 'BUILD_TOOL', supplier: 'Organization: OpenJS Foundation and Node.js contributors', versionInfo: process.version.slice(1) },
      { SPDXID: 'SPDXRef-BuildTool-esbuild', copyrightText: 'Copyright (c) 2020 Evan Wallace', downloadLocation: 'https://registry.npmjs.org/esbuild/-/esbuild-0.25.10.tgz', filesAnalyzed: false, licenseConcluded: 'MIT', licenseDeclared: 'MIT', name: 'esbuild', primaryPackagePurpose: 'BUILD_TOOL', supplier: 'Person: Evan Wallace', versionInfo: '0.25.10' }
    ],
    relationships: [
      ...files.map(file => ({ relatedSpdxElement: file.SPDXID, relationshipType: 'CONTAINS', spdxElementId: 'SPDXRef-Package-R7AIAssistant' })),
      { relatedSpdxElement: 'SPDXRef-BuildTool-Node', relationshipType: 'BUILD_TOOL_OF', spdxElementId: 'SPDXRef-Package-R7AIAssistant' },
      { relatedSpdxElement: 'SPDXRef-BuildTool-esbuild', relationshipType: 'BUILD_TOOL_OF', spdxElementId: 'SPDXRef-Package-R7AIAssistant' },
      { relatedSpdxElement: 'SPDXRef-Package-R7AIAssistant', relationshipType: 'DESCRIBES', spdxElementId: 'SPDXRef-DOCUMENT' }
    ],
    spdxVersion: 'SPDX-2.3'
  };
  if (names.length !== files.length) invalid();
  const bytes = Buffer.from(`${stableJson(document)}\n`, 'utf8');
  const path = resolve(root, output);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  return Object.freeze({ bytes, path, sha256: sha256(bytes) });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const built = await buildPlugin();
  const result = await generateSbom({ archive: built.archive });
  process.stdout.write(`SPDX 2.3 SBOM: ${result.path}; SHA-256 ${result.sha256}\n`);
}
