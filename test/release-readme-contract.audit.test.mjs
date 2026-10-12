import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const readme = readFileSync(
  new URL('../README.md', import.meta.url),
  'utf8',
);

function getSection(heading) {
  const lines = readme.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === heading);

  assert.notEqual(start, -1, `Missing README heading: ${heading}`);

  const level = heading.match(/^#+/)[0].length;
  let end = lines.length;

  for (let index = start + 1; index < lines.length; index += 1) {
    const nextHeading = /^(#{1,6})\s/.exec(lines[index]);
    if (nextHeading && nextHeading[1].length <= level) {
      end = index;
      break;
    }
  }

  return lines.slice(start + 1, end).join('\n');
}

test('expired authorization guidance does not repeat the planning oracle', () => {
  const troubleshooting = getSection('## 🔧 Troubleshooting');
  const expiredRow = troubleshooting
    .split('\n')
    .find((line) =>
      line.includes('Mutation authorization denied (EXPIRED)'),
    );

  assert.ok(expiredRow, 'Missing expired-authorization troubleshooting row');

  assert.doesNotMatch(
    expiredRow,
    /(?:re[\s-]*run|retry|repeat|invoke\s+again)[^|\n]*(?:Stage\s*2|craft_technical_prompt_with_gpt)/i,
    'Expired authorization must not trigger another planning-oracle call',
  );

  assert.match(
    readme,
    /(?:exactly once per task|only once per task|one-shot)/i,
    'README must explicitly preserve the one-shot planning contract',
  );
});

test('installation and verification explicitly require the named Docker sandbox', () => {
  const sections = [
    ['Installation', getSection('### Installation')],
    [
      'Verification',
      getSection('## 🧪 Verification & Testing Commands'),
    ],
  ];

  for (const [name, section] of sections) {
    assert.match(
      section,
      /\bkins_autonomous_sandbox\b/,
      `${name} must identify the required execution container`,
    );

    assert.match(
      section,
      /\b(?:inside|within)\b[^.\n]*\b(?:container|sandbox|kins_autonomous_sandbox)\b/i,
      `${name} must state that its commands execute inside the sandbox`,
    );

    assert.match(
      section,
      /\b(?:must|required|only)\b/i,
      `${name} must make sandbox execution mandatory, not optional`,
    );
  }
});
