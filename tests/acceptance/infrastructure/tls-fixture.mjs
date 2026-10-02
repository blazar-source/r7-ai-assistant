import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export async function tlsFixture() {
  const binary = process.platform === 'win32' ? 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe' : 'openssl';
  const run = args => {
    const result = spawnSync(binary, args, { stdio: 'ignore', timeout: 10000, windowsHide: true });
    if (result.status !== 0) throw new Error('HOST_TLS_DEPENDENCY_FAILED');
  };
  run(['version']); // Mandatory on known host; never skip or claim proof if missing.
  const directory = await mkdtemp(join(tmpdir(), 'r7-host-tls-'));
  const path = name => join(directory, name);
  try {
    run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1', '-subj', '/CN=Ephemeral Host Test CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-keyout', path('ca.key'), '-out', path('ca.pem')]);
    run(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-subj', '/CN=localhost', '-keyout', path('leaf.key'), '-out', path('leaf.csr')]);
    await writeFile(path('extensions.txt'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n');
    run(['x509', '-req', '-in', path('leaf.csr'), '-CA', path('ca.pem'), '-CAkey', path('ca.key'), '-CAcreateserial', '-days', '1', '-sha256', '-extfile', path('extensions.txt'), '-out', path('leaf.pem')]);
    run(['verify', '-CAfile', path('ca.pem'), '-verify_hostname', 'localhost', path('leaf.pem')]);
    return { keyPath: path('leaf.key'), certPath: path('leaf.pem'), ca: await readFile(path('ca.pem')), cleanup: () => rm(directory, { recursive: true, force: true }) };
  } catch {
    await rm(directory, { recursive: true, force: true });
    throw new Error('HOST_TLS_FIXTURE_FAILED');
  }
}
