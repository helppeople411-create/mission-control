/**
 * Brand Voice + User Profile.
 *
 * Two persistent markdown notes that get injected into every council session:
 *
 *  Brand Voice  — how you write: tone, style, language rules, what to avoid.
 *                 Synced to Mission Control/Brand Voice.md in your Obsidian vault.
 *
 *  User Profile — who you are, your brand, industry, audience, goals.
 *                 Synced to Mission Control/Profile.md in your Obsidian vault.
 *
 * Council agents read both before debating so their reasoning and the tasks
 * they produce always match your voice and context.
 */

import { getDatabase } from '@/lib/db';
import {
  readVaultNote,
  writeVaultNote,
  mcPath,
  isVaultConfigured,
} from './obsidian';

/* -------------------------------------------------------------------------- */
/* Brand Voice                                                                  */
/* -------------------------------------------------------------------------- */

export const BRAND_VOICE_VAULT_PATH = mcPath('Brand Voice.md');
export const PROFILE_VAULT_PATH = mcPath('Profile.md');

const BRAND_VOICE_STARTER = `# Brand Voice

## Tone
<!-- Describe your tone: professional, casual, direct, warm, etc. -->

## Writing rules
<!-- Sentence length, vocabulary level, preferred phrasing -->

## What to avoid
<!-- Jargon, buzzwords, passive voice, etc. -->

## Examples
<!-- Paste example copy that perfectly represents your voice -->
`;

const PROFILE_STARTER = `# Profile

## About me / my brand
<!-- Name, company, role, what you do -->

## Audience
<!-- Who you're writing for -->

## Industry & niche
<!-- Your market, competitors, positioning -->

## Goals
<!-- What you're trying to achieve with this system -->
`;

interface BrandNote {
  content: string;
  synced_at: number | null;
  updated_at: number;
}

function upsertBrandNote(table: 'brand_voice_notes' | 'user_profile_notes', workspaceId: number, content: string, obsidianPath?: string): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO ${table} (workspace_id, content, obsidian_path, updated_at)
     VALUES (?, ?, ?, unixepoch())
     ON CONFLICT(workspace_id) DO UPDATE
       SET content = excluded.content,
           obsidian_path = COALESCE(excluded.obsidian_path, ${table}.obsidian_path),
           updated_at = unixepoch()`
  ).run(workspaceId, content, obsidianPath ?? null);
}

function getBrandNote(table: 'brand_voice_notes' | 'user_profile_notes', workspaceId: number): BrandNote | null {
  const db = getDatabase();
  return db.prepare(
    `SELECT content, synced_at, updated_at FROM ${table} WHERE workspace_id = ?`
  ).get(workspaceId) as BrandNote | null;
}

/** Load brand voice from Obsidian vault (if configured), falling back to DB. */
export async function getBrandVoice(workspaceId: number): Promise<string> {
  // Obsidian vault takes priority when configured.
  if (isVaultConfigured()) {
    const fromVault = await readVaultNote(BRAND_VOICE_VAULT_PATH);
    if (fromVault) {
      upsertBrandNote('brand_voice_notes', workspaceId, fromVault, BRAND_VOICE_VAULT_PATH);
      return fromVault;
    }
  }
  const row = getBrandNote('brand_voice_notes', workspaceId);
  return row?.content || BRAND_VOICE_STARTER;
}

export async function setBrandVoice(workspaceId: number, content: string): Promise<void> {
  upsertBrandNote('brand_voice_notes', workspaceId, content, BRAND_VOICE_VAULT_PATH);
  await writeVaultNote(BRAND_VOICE_VAULT_PATH, content);
}

/** Load user profile from Obsidian vault, falling back to DB. */
export async function getUserProfile(workspaceId: number): Promise<string> {
  if (isVaultConfigured()) {
    const fromVault = await readVaultNote(PROFILE_VAULT_PATH);
    if (fromVault) {
      upsertBrandNote('user_profile_notes', workspaceId, fromVault, PROFILE_VAULT_PATH);
      return fromVault;
    }
  }
  const row = getBrandNote('user_profile_notes', workspaceId);
  return row?.content || PROFILE_STARTER;
}

export async function setUserProfile(workspaceId: number, content: string): Promise<void> {
  upsertBrandNote('user_profile_notes', workspaceId, content, PROFILE_VAULT_PATH);
  await writeVaultNote(PROFILE_VAULT_PATH, content);
}

/**
 * Build the memory context block injected into council system prompts.
 * Returns a string council agents can read before debating.
 */
export async function buildMemoryContext(workspaceId: number): Promise<string> {
  const [voice, profile] = await Promise.all([
    getBrandVoice(workspaceId),
    getUserProfile(workspaceId),
  ]);

  const voiceStripped = voice.replace(/^#.*$/gm, '').trim();
  const profileStripped = profile.replace(/^#.*$/gm, '').trim();

  const parts: string[] = [];
  if (profileStripped && !profileStripped.startsWith('<!--')) {
    parts.push(`## About this brand / user\n${profileStripped}`);
  }
  if (voiceStripped && !voiceStripped.startsWith('<!--')) {
    parts.push(`## Brand voice and writing rules\n${voiceStripped}`);
  }
  return parts.join('\n\n');
}
