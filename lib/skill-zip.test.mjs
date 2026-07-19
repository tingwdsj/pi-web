import assert from "node:assert/strict";
import test from "node:test";
import AdmZip from "adm-zip";

async function loadSubject() {
  return import("./skill-zip.ts");
}

const SKILL_MD_ROOT = `---
name: my-skill
description: a test skill
---
# My Skill
body
`;

const SKILL_MD_NESTED = `---
name: nested-skill
description: nested
---
nested body
`;

function zipRootSkill() {
  const zip = new AdmZip();
  zip.addFile("SKILL.md", Buffer.from(SKILL_MD_ROOT, "utf-8"));
  zip.addFile("scripts/run.sh", Buffer.from("echo hi", "utf-8"));
  return zip.toBuffer();
}

function zipNestedSkill() {
  const zip = new AdmZip();
  zip.addFile("my-skill-pkg/SKILL.md", Buffer.from(SKILL_MD_NESTED, "utf-8"));
  zip.addFile("my-skill-pkg/lib/a.js", Buffer.from("// a", "utf-8"));
  return zip.toBuffer();
}

function zipMultiTopLevel() {
  const zip = new AdmZip();
  zip.addFile("pkg1/SKILL.md", Buffer.from(SKILL_MD_ROOT, "utf-8"));
  zip.addFile("pkg2/other.txt", Buffer.from("x", "utf-8"));
  return zip.toBuffer();
}

function zipNoSkillMd() {
  const zip = new AdmZip();
  zip.addFile("README.md", Buffer.from("no skill here", "utf-8"));
  return zip.toBuffer();
}

test("reads a zip with SKILL.md at root", async () => {
  const { readZipEntries, parseSkillZip } = await loadSubject();
  const entries = readZipEntries(zipRootSkill());
  const parsed = parseSkillZip(entries);
  assert.equal(parsed.name, "my-skill");
  assert.equal(parsed.rootPrefix, "");
  assert.equal(parsed.skillMdPath, "SKILL.md");
});

test("reads a zip with SKILL.md inside a single top-level dir", async () => {
  const { readZipEntries, parseSkillZip } = await loadSubject();
  const entries = readZipEntries(zipNestedSkill());
  const parsed = parseSkillZip(entries);
  assert.equal(parsed.name, "nested-skill");
  assert.equal(parsed.rootPrefix, "my-skill-pkg");
  assert.equal(parsed.skillMdPath, "my-skill-pkg/SKILL.md");
});

test("rejects an archive with multiple top-level entries and no root SKILL.md", async () => {
  const { readZipEntries, parseSkillZip } = await loadSubject();
  const entries = readZipEntries(zipMultiTopLevel());
  assert.throws(() => parseSkillZip(entries), /SKILL\.md/);
});

test("rejects path-traversal entries (segment-level)", async () => {
  // Test isTraversalEntry directly: adm-zip silently strips a leading "../"
  // when writing, so it can't round-trip a real malicious archive. The guard
  // must catch "../" / absolute / drive-prefixed paths that a hand-crafted
  // (non-adm-zip) zip would contain.
  const { isTraversalEntry } = await loadSubject();
  assert.equal(isTraversalEntry("../escape.txt"), true);
  assert.equal(isTraversalEntry("foo/../../etc/passwd"), true);
  assert.equal(isTraversalEntry("C:\\windows\\sys"), true);
  assert.equal(isTraversalEntry("//unc/share"), true);
  assert.equal(isTraversalEntry("normal/path/SKILL.md"), false);
  assert.equal(isTraversalEntry("SKILL.md"), false);
});

test("rejects an archive with no SKILL.md", async () => {
  const { readZipEntries, parseSkillZip } = await loadSubject();
  const entries = readZipEntries(zipNoSkillMd());
  assert.throws(() => parseSkillZip(entries), /SKILL\.md/);
});
