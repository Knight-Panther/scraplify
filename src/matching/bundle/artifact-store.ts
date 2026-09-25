import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ARTIFACT_FILE_NAMES } from './contract.js';

/**
 * Where immutable bundle versions live (change.md §8). The first deployment
 * uses a persistent local directory served from the same origin; object
 * storage or a CDN is a different implementation of this interface, not a
 * domain change.
 */
export interface MatchingArtifactStore {
  /** Writes a complete version atomically: it either appears whole or not at all. Refuses to overwrite. */
  writeVersion(bundleId: string, files: ReadonlyMap<string, Uint8Array>): Promise<void>;
  /** Null when the version or file does not exist. */
  readFile(bundleId: string, fileName: string): Promise<Uint8Array | null>;
  hasVersion(bundleId: string): Promise<boolean>;
  removeVersion(bundleId: string): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FILE_NAMES: ReadonlySet<string> = new Set(ARTIFACT_FILE_NAMES);

export class ArtifactPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactPathError';
  }
}

/**
 * Every path this store touches is built from a validated uuid and a name
 * from a fixed allowlist, so a request-supplied id or file name can never
 * reach outside the root (`../`, absolute paths, alternate separators).
 */
function checkId(bundleId: string): void {
  if (!UUID.test(bundleId)) throw new ArtifactPathError('invalid bundle id');
}
function checkFileName(fileName: string): void {
  if (!FILE_NAMES.has(fileName)) throw new ArtifactPathError('unknown artifact file');
}

export class FilesystemArtifactStore implements MatchingArtifactStore {
  constructor(readonly root: string) {}

  async writeVersion(bundleId: string, files: ReadonlyMap<string, Uint8Array>): Promise<void> {
    checkId(bundleId);
    for (const name of files.keys()) checkFileName(name);
    await fs.mkdir(this.root, { recursive: true });
    const target = path.join(this.root, bundleId);
    // Staged in a sibling directory, then renamed: rename within one
    // filesystem is atomic, so a crash mid-write leaves only a `.tmp-`
    // directory no reader ever resolves, never a half-written version.
    const staging = path.join(this.root, `.tmp-${bundleId}-${randomUUID()}`);
    await fs.mkdir(staging);
    try {
      for (const [name, bytes] of files) {
        const handle = await fs.open(path.join(staging, name), 'wx');
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
      if (await this.hasVersion(bundleId)) {
        throw new ArtifactPathError(`version ${bundleId} already exists`);
      }
      await fs.rename(staging, target);
    } catch (err) {
      await fs.rm(staging, { recursive: true, force: true });
      throw err;
    }
  }

  async readFile(bundleId: string, fileName: string): Promise<Uint8Array | null> {
    checkId(bundleId);
    checkFileName(fileName);
    try {
      return new Uint8Array(await fs.readFile(path.join(this.root, bundleId, fileName)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async hasVersion(bundleId: string): Promise<boolean> {
    checkId(bundleId);
    try {
      return (await fs.stat(path.join(this.root, bundleId))).isDirectory();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  }

  async removeVersion(bundleId: string): Promise<void> {
    checkId(bundleId);
    await fs.rm(path.join(this.root, bundleId), { recursive: true, force: true });
  }
}

/**
 * `XTELO_MATCHING_ARTIFACT_DIR`, else `.matching-artifacts/` under the
 * working directory (the repo root for every npm script and `scripts/next.mjs`).
 */
export function artifactDirFromEnv(): string {
  return path.resolve(process.env.XTELO_MATCHING_ARTIFACT_DIR ?? '.matching-artifacts');
}
