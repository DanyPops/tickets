/**
 * Description template discovery — ported from emcee's internal/domain/template.go
 * (~/Workspace/emcee). Templates are discovered by sampling existing issues and
 * extracting the section-header structure repeated across all of them, not
 * hand-authored. Zero I/O: callers supply the sampled descriptions.
 */

export interface Template {
  project: string;
  issueType: string;
  sections: string[];
  body: string;
}

/** Strips a Jira-style {code}...{code} wrapper, keeping only its inner content. */
const JIRA_CODE_BLOCK_RE = /\{code(?::[^}]*)?\}([\s\S]*?)\{code\}/;

/**
 * Returns the section headers ("Label:") that appear in every one of the given
 * descriptions, in the order they appear in the first description. Returns
 * undefined if no common sections are found (including on empty input).
 */
export function extractTemplateSections(descriptions: string[]): string[] | undefined {
  if (descriptions.length === 0) return undefined;

  const allSections: string[][] = [];
  for (const desc of descriptions) {
    const sections = extractSections(desc);
    if (sections.length > 0) allSections.push(sections);
  }
  if (allSections.length === 0) return undefined;

  let common = allSections[0]!;
  for (const other of allSections.slice(1)) {
    const set = new Set(other);
    common = common.filter((s) => set.has(s));
  }
  return common.length > 0 ? common : undefined;
}

/** Produces the empty template body from a list of section headers. */
export function buildTemplateBody(sections: string[] | undefined): string {
  if (!sections || sections.length === 0) return "";
  return sections.join("\n\n");
}

function extractSections(rawDesc: string): string[] {
  let desc = rawDesc.trim();
  if (desc === "") return [];

  const codeMatch = desc.match(JIRA_CODE_BLOCK_RE);
  if (codeMatch?.[1] !== undefined) desc = codeMatch[1].trim();

  const sections: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of desc.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;

    const idx = line.indexOf(":");
    if (idx < 2) continue;
    const label = line.slice(0, idx + 1);
    // Must start with an uppercase letter.
    if (label[0]! < "A" || label[0]! > "Z") continue;
    if (!isCleanLabel(label.slice(0, -1))) continue;
    if (!seen.has(label)) {
      seen.add(label);
      sections.push(label);
    }
  }
  return sections.length >= 2 ? sections : [];
}

const CLEAN_LABEL_RE = /^[\p{L}\p{N} /(),-]*$/u;

function isCleanLabel(label: string): boolean {
  return CLEAN_LABEL_RE.test(label);
}
