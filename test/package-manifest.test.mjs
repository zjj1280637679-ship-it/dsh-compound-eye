import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

/**
 * The dual-package hazard, as a test.
 *
 * WHY THIS FILE EXISTS: `@deepseek-ai/dsh-tools` keeps its tool-runtime scheduler behind a MODULE-LOCAL
 * Symbol. If a plugin bundles its own physical copy of that package into the profile, the host ends up
 * with two module instances in one process, the Symbols differ, and the scheduler reads as undefined --
 * `reading 'prepare'` -- so EVERY tool call fails, including the host's own built-in tools.
 *
 * That is not hypothetical: it is filed as issue #20 against a sibling plugin in this ecosystem
 * (dsh-computer-use v0.3.0 on DSH Desktop), and this package was written with the same mistake before
 * this test existed. The fix is shape, not code: host-owned packages are PEERS, and the pinned versions
 * live in devDependencies for local tests only.
 *
 * A test that cannot fail is not evidence, so the counterfactual is stated: against the pre-fix manifest
 * (those two packages under `dependencies`) every assertion below fails.
 */

const readJson = async (relativePath) =>
  JSON.parse(await readFile(new URL(relativePath, import.meta.url), 'utf8'))

const manifest = await readJson('../package.json')

/** Packages the DSH host owns and must provide. A plugin must never ship its own copy. */
const HOST_PACKAGES = [
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/schemastery',
]

test('host-owned DSH packages are peers, not runtime dependencies', () => {
  for (const packageName of HOST_PACKAGES) {
    assert.equal(
      manifest.dependencies?.[packageName],
      undefined,
      `${packageName} must not be bundled as a runtime dependency`,
    )
    assert.equal(
      manifest.peerDependencies?.[packageName],
      '*',
      `${packageName} must be resolved from the DSH host`,
    )
    assert.ok(
      manifest.devDependencies?.[packageName],
      `${packageName} must remain available for local tests`,
    )
  }
})

test('the package declares no runtime dependencies at all', () => {
  // This plugin's only imports are node: builtins and its own lib/*. A dependency appearing here is a
  // signal someone reached for a library instead of writing the 40 lines -- and would reintroduce the
  // duplicate-instance hazard the moment that library shared a Symbol with the host.
  const deps = manifest.dependencies ?? {}
  assert.deepEqual(Object.keys(deps), [], `unexpected runtime dependencies: ${Object.keys(deps).join(', ')}`)
})

test('the entry point and bundle patch are declared, and exist in files[]', () => {
  assert.equal(manifest.main, 'index.js')
  assert.equal(manifest.dsh?.bundle?.patch, 'cordis.patch.yml')
  for (const needed of ['index.js', 'lib/', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
    assert.ok(manifest.files?.includes(needed), `files[] must ship ${needed}`)
  }
})

test('the bundle patch mounts this package by name, and touches no exclusive registry', async () => {
  const raw = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  // Strip comments before asserting on content: this file's header EXPLAINS that it avoids the
  // computer-use registry, and a naive match on "computer-use" hits the explanation rather than the
  // configuration. (An earlier version of this test did exactly that and failed on its own comment.)
  const yaml = raw.split(/\r?\n/).filter(l => !/^\s*#/.test(l)).join('\n')
  assert.match(yaml, new RegExp(`name:\\s*${manifest.name}\\b`),
    'the patch must insert this package by its own name')
  assert.doesNotMatch(yaml, /computer-?use/i,
    'the effective configuration must not reference the exclusive computer-use registry')
  assert.match(yaml, /^\s*-?\s*insert:/m, 'the patch must be an insert patch')
})
