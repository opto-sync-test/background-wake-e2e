import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pin = JSON.parse(fs.readFileSync(path.join(root, 'proof-source.json'), 'utf8'));

if (pin.schemaVersion !== 1) throw new Error('unsupported proof-source schema');
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(pin.repository)) {
  throw new Error('repository must use owner/name form');
}
if (!Number.isSafeInteger(pin.pullRequest) || pin.pullRequest < 1) {
  throw new Error('pullRequest must be a positive integer');
}
if (!/^[0-9a-f]{40}$/.test(pin.commit)) {
  throw new Error('commit must be an immutable 40-character SHA');
}
if (pin.linearIssue !== 'DEN-2132') throw new Error('unexpected Linear issue pin');
if (pin.contract !== 'connectivity-save-signals-v1') {
  throw new Error('unexpected connectivity proof contract');
}

const output = [
  `repository=${pin.repository}`,
  `pull_request=${pin.pullRequest}`,
  `commit=${pin.commit}`,
  `linear_issue=${pin.linearIssue}`,
  `contract=${pin.contract}`,
].join('\n');

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${output}\n`);
}
process.stdout.write(`${JSON.stringify(pin, null, 2)}\n`);
