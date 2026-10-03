import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createExecutor } from '../../lib/eye.js'

// Recreate delivery with the current plugin. Archived manifests remain the scoring source.
const source = fileURLToPath(new URL('native.png', import.meta.url))
const output = resolve(process.argv[2] || 'work/luna-delivery')
for (const [arm, depth, maxEdge] of [['native', 0, 3840], ['downscaled', 0, 1568], ['tiled', 4, 1568]]) {
  const dir = resolve(output, arm)
  await mkdir(dir, { recursive: true })
  const images = []
  const ctx = { get: () => ({ async saveImage({ data, name }) {
    await writeFile(resolve(dir, name), data)
    images.push({ path: name })
    return { image: { attachmentId: String(images.length) } }
  } }) }
  const exec = createExecutor({ ctx, cfg: { deliveryMaxEdge: maxEdge } })
  const result = await exec.run({ image: { path: source }, depth })
  const manifest = { arm, source: { w: result.source.w, h: result.source.h }, images: result.tiles.map((tile, i) => ({
    ...images[i], source: tile.source, delivered: tile.delivered, caption: tile.caption,
  })) }
  await writeFile(resolve(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  console.log(`${arm}: ${images.length} images saved to ${dir}`)
}
