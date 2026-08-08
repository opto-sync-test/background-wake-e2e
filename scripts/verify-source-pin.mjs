import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pin = JSON.parse(fs.readFileSync(path.join(root, 'proof-source.json'), 'utf8'));
const source = path.join(root, 'source');

const checkedOut = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
assert.equal(checkedOut, pin.commit, 'source checkout does not match the immutable merged proof pin');

// `git submodule status` deliberately encodes exactness in column zero:
// a leading space is exact, `-` is uninitialized, `+` is a different commit,
// and `U` is conflicted. Do not trim that marker before validating it.
const submodules = execFileSync(
  'git',
  ['-C', source, 'submodule', 'status', '--recursive'],
  { encoding: 'utf8' },
)
  .split('\n')
  .filter((line) => line.length > 0);
assert.ok(submodules.length > 0, 'the pinned syncer.c source must be materialized');
for (const line of submodules) {
  assert.equal(line[0], ' ', `submodule is not at its committed gitlink: ${line}`);
}

const headers = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'opto-sync-test-connectivity-proof',
};
if (process.env.GITHUB_TOKEN) {
  headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
}
const response = await fetch(
  `https://api.github.com/repos/${pin.repository}/pulls/${pin.pullRequest}`,
  { headers },
);
assert.equal(response.status, 200, `GitHub PR lookup failed: ${response.status}`);
const pullRequest = await response.json();
assert.equal(pullRequest.state, 'closed', 'the source proof PR must be closed after delivery');
assert.ok(pullRequest.merged_at, 'the source proof PR must be merged, not merely closed');
assert.equal(pullRequest.head.sha, pin.candidateHead, 'the reviewed source candidate head changed');
assert.equal(pullRequest.merge_commit_sha, pin.commit, 'the proof pin is not the PR merge commit');
assert.equal(pullRequest.base.ref, 'main');
assert.equal(pullRequest.draft, false, 'the implementation must have left draft before merge');

process.stdout.write(
  `${JSON.stringify(
    {
      repository: pin.repository,
      pullRequest: pin.pullRequest,
      candidateHead: pin.candidateHead,
      commit: pin.commit,
      mergedAt: pullRequest.merged_at,
      submodules,
      sourcePrUrl: pullRequest.html_url,
    },
    null,
    2,
  )}\n`,
);
