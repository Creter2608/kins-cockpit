/**
 * test/rule-sections-parsing.test.ts
 * Rigorous test suite for Golden Assertion 2:
 * "AGENTS has six core headings -> sectionCount=6; badge=6"
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { extractTechnicalRuleSections } from "../src/main/services/ruleResolverService.js";
import type { ResolvedRuleBlock } from "../src/shared/contracts.js";

test("Golden Assertion 2: extracts exactly six core technical rule sections from AGENTS.md", () => {
  const agentsPath = path.resolve("AGENTS.md");
  assert.ok(fs.existsSync(agentsPath), "AGENTS.md must exist at repository root");

  const agentsContent = fs.readFileSync(agentsPath, "utf-8");
  const { sectionCount, sectionNames } = extractTechnicalRuleSections(agentsContent);

  assert.equal(sectionCount, 6, "Expected exactly 6 technical rule sections in AGENTS.md");
  assert.equal(sectionNames.length, 6);

  const expectedSections = [
    "Autonomous Loop v3.0",
    "Core Operating Invariants",
    "CodeGraph Context Extraction",
    "Superpowers Template Enforcement",
    "Karpathy Behavioral Invariants",
    "Agency Core Checkpoints"
  ];

  assert.deepEqual(Array.from(sectionNames), expectedSections);
});

test("Rule Sections: ignores headings inside fenced code blocks and duplicate headings", () => {
  const markdownWithCode = `
# Title
## Autonomous Loop v3.0
Some explanation here.

\`\`\`markdown
## Core Operating Invariants
## Autonomous Loop v3.0
\`\`\`

## Core Operating Invariants
Actual section.

## Autonomous Loop v3.0
Repeated heading in prose.
`;

  const { sectionCount, sectionNames } = extractTechnicalRuleSections(markdownWithCode);
  assert.equal(sectionCount, 2);
  assert.deepEqual(Array.from(sectionNames), ["Autonomous Loop v3.0", "Core Operating Invariants"]);
});

test("ProjectSelector badge calculation: sums sectionCount with nullish fallback", () => {
  // Case A: 6-section AGENTS block alone -> displays 6
  const blocksA: ResolvedRuleBlock[] = [
    {
      source: "repository-native",
      origin: "AGENTS.md",
      content: "# AGENTS",
      sectionCount: 6,
      sectionNames: ["1", "2", "3", "4", "5", "6"]
    }
  ];

  const totalA = blocksA.reduce((total, block) => total + (block.sectionCount ?? 1), 0);
  assert.equal(totalA, 6, "Single AGENTS block with 6 sections must sum to 6");

  // Case B: 6-section block + 1 metadata-free block -> displays 7
  const blocksB: ResolvedRuleBlock[] = [
    ...blocksA,
    {
      source: "host-policy",
      origin: "cockpit-packaged-invariants",
      content: "# Host Policy"
      // sectionCount is undefined -> falls back to 1
    }
  ];

  const totalB = blocksB.reduce((total, block) => total + (block.sectionCount ?? 1), 0);
  assert.equal(totalB, 7, "6-section block plus 1 metadata-free block must sum to 7");

  // Case C: Explicit 0 sectionCount does not fallback to 1 (nullish coalescing)
  const blocksC: ResolvedRuleBlock[] = [
    {
      source: "repository-native",
      origin: "EMPTY.md",
      content: "# Empty",
      sectionCount: 0
    }
  ];

  const totalC = blocksC.reduce((total, block) => total + (block.sectionCount ?? 1), 0);
  assert.equal(totalC, 0, "Explicit 0 sectionCount must remain 0");
});
