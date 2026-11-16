/**
 * What a person lets their AI agents do (ADR 0057 addendum 3, owner decisions
 * 2026-11-10). An agent works on its person's account and that person is its
 * one admin; this is the person's single setting for it, kept in their own
 * workspace at `agents/settings`:
 *
 *   viewer    "Read only": the agent reads and suggests; it never changes a
 *             diagram. The default.
 *   proposer  "Changes need my approval": the agent's changes are carried out
 *             only once the person approves them.
 *
 * On a given diagram the agent never goes above its person
 * (sharing.agentLevelOn): on a diagram shared with the person as Read only,
 * the agent is Read only whatever this says.
 */
import { AGENT_LEVELS, SharingError } from './sharing.js';

export const AGENT_SETTINGS_KEY = 'agents/settings';
export const DEFAULT_AGENT_LEVEL = 'viewer';

/** @param {{ adapterFor: (workspaceId: string) => object }} deps */
export function createAgentSettings({ adapterFor }) {
  return {
    async get(sub) {
      const bytes = await adapterFor(sub).get(AGENT_SETTINGS_KEY);
      if (!bytes) return { level: DEFAULT_AGENT_LEVEL };
      try {
        const { level } = JSON.parse(new TextDecoder().decode(bytes));
        return { level: AGENT_LEVELS.includes(level) ? level : DEFAULT_AGENT_LEVEL };
      } catch {
        return { level: DEFAULT_AGENT_LEVEL };
      }
    },

    async set(sub, level) {
      if (!AGENT_LEVELS.includes(level)) {
        throw new SharingError(400, 'invalid-level', 'An AI agent can be Read only or Changes need my approval');
      }
      const settings = { level };
      await adapterFor(sub).put(AGENT_SETTINGS_KEY, new TextEncoder().encode(JSON.stringify(settings)));
      return settings;
    }
  };
}
