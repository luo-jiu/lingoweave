import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const requestedDestination = process.argv[2];
if (!requestedDestination || process.argv.length !== 3 || !isAbsolute(requestedDestination))
  throw new Error('Usage: node scripts/package-mini-service.mjs /absolute/service-directory');
const destination = resolve(requestedDestination);
if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch))
  throw new Error('The mini application packages a matching macOS Node runtime.');

const nodeVersion = '22.22.0';
const archiveName = `node-v${nodeVersion}-darwin-${process.arch}.tar.xz`;
const archiveSha = {
  arm64: '2bd596bbfc4a275ceb8721a5954ee97daea5ebe673e96a185ebd732f6fb023ac',
  x64: '48bc437e00e0c1483da34c21dca196efcb8d22e5dcb0bc7c65386afb00fabb85',
}[process.arch];
const archiveUrl = `https://nodejs.org/dist/v${nodeVersion}/${archiveName}`;
const runtimeDirectory = join(homedir(), 'sdks', 'node', nodeVersion, `darwin-${process.arch}`);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function installedRuntime() {
  try {
    const manifest = JSON.parse(await readFile(join(runtimeDirectory, 'manifest.json'), 'utf8'));
    const binary = join(runtimeDirectory, 'node');
    if (
      manifest.archiveSha256 !== archiveSha ||
      manifest.binarySha256 !== sha256(await readFile(binary)) ||
      execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim() !== `v${nodeVersion}`
    )
      throw new Error('The managed Node runtime no longer matches its fixed manifest.');
    return binary;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const parent = dirname(runtimeDirectory);
  await mkdir(parent, { recursive: true });
  const temporary = await mkdtemp(join(parent, '.node-install-'));
  try {
    const archive = join(temporary, archiveName);
    execFileSync(
      '/usr/bin/curl',
      [
        '--fail',
        '--location',
        '--retry',
        '2',
        '--connect-timeout',
        '15',
        '--max-time',
        '180',
        '--output',
        archive,
        archiveUrl,
      ],
      { stdio: ['ignore', 'ignore', 'inherit'] },
    );
    if (sha256(await readFile(archive)) !== archiveSha)
      throw new Error('The official Node archive failed its pinned SHA-256 check.');
    execFileSync('/usr/bin/tar', ['-xJf', archive, '-C', temporary]);
    const extracted = join(temporary, `node-v${nodeVersion}-darwin-${process.arch}`);
    const staged = join(temporary, 'runtime');
    await mkdir(staged);
    await cp(join(extracted, 'bin', 'node'), join(staged, 'node'));
    await cp(join(extracted, 'LICENSE'), join(staged, 'license.txt'));
    await chmod(join(staged, 'node'), 0o755);
    await writeFile(
      join(staged, 'manifest.json'),
      JSON.stringify(
        {
          version: nodeVersion,
          platform: 'darwin',
          architecture: process.arch,
          source: archiveUrl,
          archiveSha256: archiveSha,
          binarySha256: sha256(await readFile(join(staged, 'node'))),
        },
        null,
        2,
      ) + '\n',
    );
    try {
      await rename(staged, runtimeDirectory);
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error?.code)) throw error;
      return await installedRuntime();
    }
    return join(runtimeDirectory, 'node');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function findPackage(name, startingDirectory) {
  let current = startingDirectory;
  while (true) {
    const candidate = join(current, 'node_modules', name);
    try {
      await access(join(candidate, 'package.json'), constants.R_OK);
      return await realpath(candidate);
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) throw error;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

await mkdir(destination, { recursive: true });
if ((await readdir(destination)).length > 0)
  throw new Error('The packaged service destination must be empty.');
const packages = new Map();
const packageManifest = [];

async function copyPackage(source) {
  if (packages.has(source)) return packages.get(source);
  const metadata = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  const key = sha256(Buffer.from(relative(project, source))).slice(0, 20);
  const target = join(destination, 'node_modules', '.packages', key);
  packages.set(source, target);
  if (source.startsWith(join(project, 'packages') + sep)) {
    await mkdir(target, { recursive: true });
    await cp(join(source, 'package.json'), join(target, 'package.json'));
    for (const file of metadata.files ?? ['dist'])
      await cp(join(source, file), join(target, file), { recursive: true, dereference: true });
  } else {
    await cp(source, target, {
      recursive: true,
      dereference: true,
      filter: (path) => path !== join(source, 'node_modules') && path !== join(source, '.git'),
    });
  }
  const optional = new Set(Object.keys(metadata.optionalDependencies ?? {}));
  const required = new Set(
    Object.keys(metadata.dependencies ?? {}).filter((name) => !optional.has(name)),
  );
  const dependencies = new Set([
    ...required,
    ...optional,
    ...Object.keys(metadata.peerDependencies ?? {}),
  ]);
  for (const name of dependencies) {
    const dependency = await findPackage(name, source);
    if (!dependency) {
      if (required.has(name))
        throw new Error(`Missing installed dependency ${name} for ${metadata.name}.`);
      continue;
    }
    const copied = await copyPackage(dependency);
    const link = join(target, 'node_modules', name);
    await mkdir(dirname(link), { recursive: true });
    await symlink(relative(dirname(link), copied), link);
  }
  packageManifest.push({
    name: metadata.name,
    version: metadata.version,
    directory: relative(destination, target),
  });
  return target;
}

const serverDirectory = join(project, 'apps/server');
const serverMetadata = JSON.parse(await readFile(join(serverDirectory, 'package.json'), 'utf8'));
const serverTarget = join(destination, 'apps/server');
await mkdir(serverTarget, { recursive: true });
await cp(join(serverDirectory, 'dist'), join(serverTarget, 'dist'), { recursive: true });
await cp(join(serverDirectory, 'package.json'), join(serverTarget, 'package.json'));
for (const name of Object.keys(serverMetadata.dependencies)) {
  const source = await findPackage(name, serverDirectory);
  if (!source) throw new Error(`Missing installed server dependency ${name}.`);
  const target = await copyPackage(source);
  const link = join(serverTarget, 'node_modules', name);
  await mkdir(dirname(link), { recursive: true });
  await symlink(relative(dirname(link), target), link);
}
await mkdir(join(destination, 'scripts'), { recursive: true });
for (const file of ['mini-service.mjs', 'mini-reset.mjs', 'mini-tts-worker.py'])
  await cp(join(project, 'scripts', file), join(destination, 'scripts', file));
await cp(join(project, 'skills'), join(destination, 'skills'), { recursive: true });
// Keep the workspace path used by build fingerprinting and contracts exports.
await mkdir(join(destination, 'packages/contracts'), { recursive: true });
await cp(join(project, 'packages/contracts/dist'), join(destination, 'packages/contracts/dist'), {
  recursive: true,
});
await writeFile(
  join(destination, 'package.json'),
  JSON.stringify({ private: true, type: 'module' }) + '\n',
);

const node = await installedRuntime();
await mkdir(join(destination, 'runtime'), { recursive: true });
await cp(node, join(destination, 'runtime/node'));
await cp(join(runtimeDirectory, 'license.txt'), join(destination, 'runtime/license.txt'));
execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', join(destination, 'runtime/node')], {
  stdio: 'ignore',
});
const runtimeManifest = JSON.parse(await readFile(join(runtimeDirectory, 'manifest.json'), 'utf8'));
const contents = createHash('sha256');
async function verifyLinks(directory) {
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name),
      info = await lstat(path);
    contents.update(relative(destination, path) + '\0');
    if (info.isSymbolicLink()) {
      const link = await readlink(path);
      const target = resolve(dirname(path), link);
      if (target !== destination && !target.startsWith(destination + sep))
        throw new Error('A packaged dependency link escapes the application resources.');
      await access(path);
      contents.update('link\0' + link);
    } else if (info.isDirectory()) await verifyLinks(path);
    else contents.update('file\0').update(await readFile(path));
  }
}
await verifyLinks(destination);
await writeFile(
  join(destination, 'runtime-manifest.json'),
  JSON.stringify(
    {
      ...runtimeManifest,
      binarySha256: sha256(await readFile(join(destination, 'runtime/node'))),
      contentsSha256: contents.digest('hex'),
      dependencies: packageManifest.sort((left, right) =>
        left.directory.localeCompare(right.directory),
      ),
    },
    null,
    2,
  ) + '\n',
);
execFileSync(
  join(destination, 'runtime/node'),
  [
    '--input-type=module',
    '-e',
    "await import('./apps/server/dist/app.js'); await import('./apps/server/dist/mini-ai-service.js'); await import('./apps/server/dist/mini-audio-service.js');",
  ],
  { cwd: destination, stdio: 'inherit' },
);
process.stdout.write(
  `Packaged mini service with Node ${nodeVersion} and ${packageManifest.length} installed dependency contexts.\n`,
);
