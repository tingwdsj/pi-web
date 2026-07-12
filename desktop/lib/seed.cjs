"use strict";

// First-run seeding of the pi agent data directory.
//
// Mirrors the SDK's getAgentDir() resolution
// (node_modules/@earendil-works/pi-coding-agent/dist/config.js):
//   - PI_CODING_AGENT_DIR env var (with ~ expansion) if set
//   - otherwise path.join(os.homedir(), ".pi", "agent")
//
// We do NOT set PI_CODING_AGENT_DIR when spawning the Next server, so both the
// seed and the server agree on ~/.pi/agent. This also means the desktop app
// shares its data dir with any pi CLI the user may already have installed —
// existing config and session history are inherited, never overwritten.

const fs = require("fs");
const os = require("os");
const path = require("path");

function resolveAgentDir() {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir) {
    const expanded = envDir.startsWith("~/")
      ? path.join(os.homedir(), envDir.slice(2))
      : envDir;
    return path.resolve(expanded);
  }
  return path.join(os.homedir(), ".pi", "agent");
}

// Seed models.json + settings.json ONLY if they do not already exist.
// Returns { agentDir, seeded: string[] }.
function seedIfMissing() {
  const agentDir = resolveAgentDir();
  const seeded = [];
  const files = [
    ["models.json", "seed-models.json"],
    ["settings.json", "seed-settings.json"],
  ];
  for (const [name, seedFile] of files) {
    const target = path.join(agentDir, name);
    if (!fs.existsSync(target)) {
      fs.mkdirSync(agentDir, { recursive: true });
      const seedContent = fs.readFileSync(path.join(__dirname, "..", seedFile), "utf8");
      fs.writeFileSync(target, seedContent, { mode: 0o600 });
      seeded.push(name);
    }
  }
  return { agentDir, seeded };
}

module.exports = { seedIfMissing, resolveAgentDir };
