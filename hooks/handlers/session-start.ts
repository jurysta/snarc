#!/usr/bin/env node
/**
 * SessionStart hook — initialize engram for this session.
 */

import { EngramMemory } from '../../src/memory.js';
import { randomUUID } from 'node:crypto';

const sessionId = process.env.SESSION_ID || randomUUID().slice(0, 8);
const cwd = process.cwd();

try {
  const memory = new EngramMemory();
  memory.initSession(sessionId, cwd);
  memory.close();
} catch (e) {
  // Silent failure — engram should never block Claude Code
}

// Write session ID for subsequent hooks
process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
