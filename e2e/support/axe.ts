import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

export interface AxeViolationSummary {
  id: string;
  impact: string | null | undefined;
  help: string;
  nodes: string[];
}

export interface AxeOptions {
  /** CSS selectors to leave out (e.g. third-party embeds). Keep this empty unless justified in the test. */
  exclude?: string[];
  /** Impacts that fail the check. Default: serious and critical (TID-005 AC2). */
  failOn?: Array<'minor' | 'moderate' | 'serious' | 'critical'>;
}

/** Run axe against the current page and return the violations that matter, in a readable shape. */
export async function axeViolations(
  page: Page,
  options: AxeOptions = {},
): Promise<AxeViolationSummary[]> {
  const failOn = new Set(options.failOn ?? ['serious', 'critical']);
  let builder = new AxeBuilder({ page }).withTags([
    'wcag2a',
    'wcag2aa',
    'wcag21a',
    'wcag21aa',
    'wcag22aa',
  ]);
  for (const selector of options.exclude ?? []) builder = builder.exclude(selector);
  const results = await builder.analyze();
  return results.violations
    .filter((v) => v.impact && failOn.has(v.impact))
    .map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      nodes: v.nodes.map((n) => n.target.join(' ')),
    }));
}

/** Usage: `expect(await axeViolations(page)).toEqual([])`. This wrapper gives a clearer failure message. */
export async function expectNoSeriousA11yViolations(
  page: Page,
  options?: AxeOptions,
): Promise<void> {
  const violations = await axeViolations(page, options);
  if (violations.length > 0) {
    throw new Error(
      `axe found ${violations.length} serious/critical violation(s):\n` +
        violations
          .map((v) => `- [${v.impact}] ${v.id}: ${v.help}\n    ${v.nodes.join('\n    ')}`)
          .join('\n'),
    );
  }
}
