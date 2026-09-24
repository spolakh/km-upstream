/**
 * Post-build gate: the deferred extension safelist (extension-utilities.css)
 * must be a canonical-order SUPERSET of the app stylesheet's utilities.
 *
 * Both sheets put their rules in the `utilities` cascade layer, and the
 * safelist is appended after the app sheet once it loads. For any two
 * utilities both sheets emit, the safelist's order then decides the cascade
 * for every element on the page, core's included. So the safelist must emit
 * every utility the app emits, in the same relative order: a utility either
 * appears there in Tailwind's canonical order or not at all. The failure is
 * silent otherwise: a base utility re-emitted after the app's variant of it
 * (`flex-col` after `@md:flex-row`) wins the cascade, and nothing reports it.
 *
 * Has to run against `dist/`: the order is a property of the two Tailwind
 * runs' emitted output, which no source-level test sees.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import postcss, { type AtRule, type Container, type Rule } from 'postcss'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distDir = path.join(rootDir, 'dist')

const fail = (message: string): never => {
  console.error(`[check-dist-css-order] ${message}`)
  process.exit(1)
}

if (!fs.existsSync(distDir)) fail('no dist/ — run the build first')

/** Both sheets sit in dist/ under their entry names (`assetFileNames:
 *  '[name][extname]'`): the app stylesheet is whatever dist/index.html links,
 *  the safelist is the chunk named after its entry. */
const html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8')
const linked = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)]
  .map(match => path.join(distDir, path.basename(match[1])))
if (linked.length !== 1) fail(`expected one stylesheet linked from index.html, found ${linked.length}: ${linked.join(', ') || '(none)'}`)
const appCss = linked[0]
const safelistCss = path.join(distDir, 'extension-utilities.css')
if (!fs.existsSync(appCss)) fail(`linked stylesheet not in dist/: ${appCss}`)
if (!fs.existsSync(safelistCss)) fail(`no ${safelistCss} — did the safelist entry stop being its own chunk?`)

/** Every rule under `@layer utilities`, in document order, keyed by its
 *  selector plus the conditional at-rules wrapping it (a `.flex` inside
 *  `@container (width >= 28rem)` is a different rule from a bare `.flex`). */
const utilityRuleKeys = (file: string): string[] => {
  const root = postcss.parse(fs.readFileSync(file, 'utf8'))
  const keys: string[] = []
  const walk = (container: Container, context: string[], inUtilities: boolean) => {
    container.each(node => {
      if (node.type === 'rule') {
        // One key per selector: the minifier merges adjacent rules with
        // identical declarations into a selector list (`.divide-border` and
        // `.divide-border\/40` share one block in the safelist sheet and
        // not in the app's), and the comparison is about where each
        // selector lands, not how the blocks were coalesced.
        if (inUtilities) {
          for (const selector of (node as Rule).selectors) keys.push([...context, selector].join(' > '))
        }
        return
      }
      if (node.type !== 'atrule') return
      const atRule = node as AtRule
      const isLayer = atRule.name === 'layer'
      const nowUtilities = inUtilities || (isLayer && atRule.params.trim() === 'utilities')
      const nextContext = isLayer ? context : [...context, `@${atRule.name} ${atRule.params}`]
      walk(atRule, nextContext, nowUtilities)
    })
  }
  walk(root, [], false)
  return keys
}

/** Rules the app AUTHORS in `@layer utilities` (index.css) are not Tailwind
 *  utilities and never reach the safelist sheet; only the generated ones are
 *  held to the superset rule. */
const authoredSelectors = new Set(
  utilityRuleKeys(path.join(rootDir, 'src', 'index.css')).map(key => key.replace(/\s+/g, '')),
)
const appKeys = utilityRuleKeys(appCss).filter(key => !authoredSelectors.has(key.replace(/\s+/g, '')))
const safelistKeys = utilityRuleKeys(safelistCss)
if (appKeys.length === 0) fail(`no @layer utilities rules found in ${appCss}`)

// Subsequence match: each app rule must appear in the safelist at or after
// the previous app rule's position.
let cursor = 0
for (const key of appKeys) {
  const found = safelistKeys.indexOf(key, cursor)
  if (found === -1) {
    const earlier = safelistKeys.lastIndexOf(key, cursor - 1)
    fail(earlier === -1
      ? `app utility missing from the safelist sheet: ${key}`
      : `app utility out of order in the safelist sheet: ${key} (app order puts it after ${appKeys[appKeys.indexOf(key) - 1]})`)
  }
  cursor = found + 1
}

console.log(`[check-dist-css-order] ${path.basename(appCss)}: ${appKeys.length} utility rules, all present in order in ${path.basename(safelistCss)} (${safelistKeys.length} rules)`)
