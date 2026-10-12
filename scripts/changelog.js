#!/usr/bin/env node
// Builds a CHANGELOG.md section from git commits since the previous version tag.
//
// Usage: node scripts/changelog.js [--version x.y.z] [--from <ref>] [--write]
//   --version  Heading for the new section (default: version in package.json)
//   --from     Start of the range (default: newest v* tag, else the first commit)
//   --write    Prepend the section to CHANGELOG.md instead of printing it
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

const version = opt("version") ?? require(path.join(root, "package.json")).version;
const file = path.join(root, "CHANGELOG.md");

let from = opt("from");
if (!from) {
  try {
    from = git("describe", "--tags", "--abbrev=0", "--match", "v*");
  } catch {
    from = undefined;
  }
}

const SEP = "\x1f";
const log = git("log", "--no-merges", `--format=%h${SEP}%s`, from ? `${from}..HEAD` : "HEAD");
const commits = log ? log.split("\n").map((l) => l.split(SEP)) : [];

const GROUPS = ["Added", "Changed", "Fixed", "Removed"];
const conventional = { feat: "Added", fix: "Fixed", perf: "Changed", refactor: "Changed", remove: "Removed", revert: "Removed" };
const verbs = { add: "Added", added: "Added", fix: "Fixed", fixed: "Fixed", remove: "Removed", removed: "Removed", delete: "Removed", drop: "Removed" };
const SKIP = /^(release|bump|chore|docs|ci|test|style|merge|initiali[sz]e|initial)\b/i;

const sections = Object.fromEntries(GROUPS.map((g) => [g, []]));
for (const [hash, subject] of commits) {
  if (SKIP.test(subject)) continue;
  const m = subject.match(/^(\w+)(?:\([^)]*\))?!?:\s*(.+)$/);
  let group;
  let text = subject;
  if (m && conventional[m[1].toLowerCase()]) {
    group = conventional[m[1].toLowerCase()];
    text = m[2];
  } else {
    const [first, ...tail] = subject.split(/\s+/);
    group = verbs[first.toLowerCase()] ?? "Changed";
    // The heading already says "Added"/"Fixed"/..., so drop the leading verb.
    if (verbs[first.toLowerCase()] && tail.length) text = tail.join(" ");
  }
  sections[group].push(`${text.charAt(0).toUpperCase()}${text.slice(1)} (${hash})`);
}

const date = new Date().toISOString().slice(0, 10);
let body = `## [${version}] - ${date}\n`;
let any = false;
for (const g of GROUPS) {
  if (!sections[g].length) continue;
  any = true;
  body += `\n### ${g}\n${sections[g].map((s) => `- ${s}`).join("\n")}\n`;
}
if (!any) body += "\nNo notable changes.\n";

if (!args.includes("--write")) {
  process.stdout.write(body);
  process.exit(0);
}

const header = "# Changelog\n\nGenerated from commit history by `scripts/changelog.js`.\n";
const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
if (existing.includes(`## [${version}]`)) {
  console.error(`CHANGELOG.md already has a section for ${version}.`);
  process.exit(1);
}
const rest = existing.startsWith("# Changelog") ? existing.replace(/^# Changelog\n(?:\n[^#\n][^\n]*\n)*/, "") : existing;
fs.writeFileSync(file, `${header}\n${body}${rest.trim() ? `\n${rest.replace(/^\n+/, "")}` : ""}`);
console.log(`Wrote ${version} to CHANGELOG.md (${from ? `since ${from}` : "all commits"}).`);
