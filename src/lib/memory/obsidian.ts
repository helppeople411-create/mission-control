/**
 * Obsidian vault bridge.
 *
 * Mission Control can read from and write to an Obsidian vault in two ways:
 *
 *  1. FILESYSTEM (primary, always enabled when OBSIDIAN_VAULT_PATH is set)
 *     Set OBSIDIAN_VAULT_PATH=/path/to/your/vault in your .env.local.
 *     The vault IS the memory dir; Mission Control writes markdown notes
 *     directly into it and they appear in Obsidian instantly.
 *
 *  2. LOCAL REST API (optional, requires the "Local REST API" community
 *     plugin to be installed and running in Obsidian).
 *     Set OBSIDIAN_API_KEY=<your-api-key> to enable.
 *     Falls back silently to filesystem-only if unreachable.
 *
 * Folder layout inside the vault (auto-created):
 *   Mission Control/
 *     Brand Voice.md     ← your writing style and tone
 *     Profile.md         ← who you are, your brand
 *     Sessions/          ← auto-generated council session summaries
 *     Skills/            ← skill documents synced from the DB
 */

import { existsSync, mkdirSync } from 'fs';
import {
  readFile,
  writeFile,
  readdir,
  mkdir,
} from 'fs/promises';
import { join, dirname, relative, extname } from 'path';
import { logger } from '@/lib/logger';

/* -------------------------------------------------------------------------- */
/* Configuration                                                                */
/* -------------------------------------------------------------------------- */

const VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH ?? '';
const API_KEY = process.env.OBSIDIAN_API_KEY ?? '';
const API_PORT = process.env.OBSIDIAN_API_PORT ?? '27123';
const API_BASE = `http://localhost:${API_PORT}`;

export const MC_FOLDER = 'Mission Control';

export function getVaultPath(): string {
  return VAULT_PATH;
}

export function isVaultConfigured(): boolean {
  return !!VAULT_PATH && existsSync(VAULT_PATH);
}

export function isApiEnabled(): boolean {
  return !!API_KEY;
}

/** Absolute path to a note inside the vault. */
export function vaultNotePath(relPath: string): string {
  return join(VAULT_PATH, relPath);
}

/** Path to Mission Control notes. */
export function mcPath(subPath: string): string {
  return `${MC_FOLDER}/${subPath}`;
}

/* -------------------------------------------------------------------------- */
/* Filesystem read / write                                                      */
/* -------------------------------------------------------------------------- */

export async function readVaultNote(relPath: string): Promise<string | null> {
  if (!VAULT_PATH) return null;
  const abs = vaultNotePath(relPath);
  try {
    return await readFile(abs, 'utf-8');
  } catch {
    return null;
  }
}

export async function writeVaultNote(
  relPath: string,
  content: string
): Promise<boolean> {
  if (!VAULT_PATH) return false;
  const abs = vaultNotePath(relPath);
  try {
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf-8');
    logger.debug({ relPath }, 'Wrote Obsidian vault note');
    // Also try the REST API if available (keeps Obsidian's cache fresh).
    if (API_KEY) {
      apiWriteNote(relPath, content).catch(() => {});
    }
    return true;
  } catch (err) {
    logger.warn({ err, relPath }, 'Failed to write vault note');
    return false;
  }
}

/** List all markdown files under a vault subfolder. */
export async function listVaultNotes(
  subFolder = ''
): Promise<string[]> {
  if (!VAULT_PATH) return [];
  const base = subFolder ? vaultNotePath(subFolder) : VAULT_PATH;
  if (!existsSync(base)) return [];
  const results: string[] = [];
  async function walk(dir: string) {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (extname(e.name) === '.md') {
          results.push(relative(VAULT_PATH, full));
        }
      }
    } catch { /* ignore unreadable dirs */ }
  }
  await walk(base);
  return results;
}

/* -------------------------------------------------------------------------- */
/* Obsidian Local REST API (optional)                                           */
/* -------------------------------------------------------------------------- */

async function apiWriteNote(relPath: string, content: string): Promise<void> {
  if (!API_KEY) return;
  try {
    await fetch(`${API_BASE}/vault/${encodeURIComponent(relPath)}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'text/markdown',
      },
      body: content,
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // REST API is optional — swallow errors silently.
  }
}

export async function apiReadNote(relPath: string): Promise<string | null> {
  if (!API_KEY) return null;
  try {
    const res = await fetch(`${API_BASE}/vault/${encodeURIComponent(relPath)}`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      signal: AbortSignal.timeout(3000),
    });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Vault status                                                                  */
/* -------------------------------------------------------------------------- */

export interface VaultStatus {
  configured: boolean;
  vaultPath: string;
  apiEnabled: boolean;
  mcFolderExists: boolean;
  noteCount: number;
}

export async function getVaultStatus(): Promise<VaultStatus> {
  const configured = isVaultConfigured();
  const mcFolderPath = configured ? vaultNotePath(MC_FOLDER) : '';
  const mcFolderExists = !!mcFolderPath && existsSync(mcFolderPath);
  const noteCount = configured
    ? (await listVaultNotes(MC_FOLDER)).length
    : 0;
  return {
    configured,
    vaultPath: VAULT_PATH,
    apiEnabled: isApiEnabled(),
    mcFolderExists,
    noteCount,
  };
}

/** Ensure the Mission Control folder structure exists in the vault. */
export function ensureMcFolders(): void {
  if (!VAULT_PATH) return;
  for (const sub of ['', 'Sessions', 'Skills']) {
    const p = vaultNotePath(join(MC_FOLDER, sub));
    if (!existsSync(p)) mkdirSync(p, { recursive: true });
  }
}
