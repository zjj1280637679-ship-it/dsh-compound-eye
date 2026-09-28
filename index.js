/**
 * dsh-compound-eye -- compound-eye image delivery for vision models.
 *
 * TWO TOOLS, NO STATE:
 *   compound_eye        split an image into tiles and hand the tiles back as images
 *   compound_eye_probe  plan the same split and report the topology, delivering nothing
 *
 * WHY THIS PLUGIN EXISTS (the short version):
 *   A vision model reading a large screenshot is limited by how many pixels reach it per object, not
 *   by how many pixels the screen has. A whole-frame capture is resampled to the delivery ceiling
 *   (measured on this host: 1920x1040 -> 1568x849, 3840x2160 -> 1568x882), so the model never sees
 *   the source pixels at all. Cropping does not add pixels -- it stops discarding them, by letting a
 *   region own the whole delivery budget instead of sharing it with the entire screen.
 *
 * WHY IT REGISTERS NO PROVIDER:
 *   The computer-use registry (@deepseek-ai/dsh-computer-use) owns ONE exclusive provider slot. This
 *   plugin is an image processor, not a desktop driver, so it must not compete for that slot: it can
 *   be mounted beside any computer-use provider. It injects `tools` and reads `attachments` lazily.
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 *   - It does not capture the screen. Capturing is a driver concern; this tool takes an image.
 *   - It does not choose the layer count for the caller. The model picks the depth.
 *   - It does not persist a session between calls: no "last image", no "last grid". Every call states
 *     its own source, so two callers cannot overwrite each other's binding (the failure mode that
 *     "lastBlockWindow" produced in the companion plugin, where a stale global silently retargeted a
 *     click into a different window).
 */
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { makeCompoundEyeTool, makeProbeTool, createExecutor, renderTiles, renderText } from './lib/eye.js'

export const name = 'dsh-compound-eye'

/** `tools` is required (we register two). `attachments` is fetched lazily via ctx.get. */
export const inject = ['tools']

export const Config = z.object({
  /**
   * Long edge the delivery channel accepts before it silently resamples. Measured on this host: the
   * capture path clamps to 1568. A different host may differ, so this is configuration, not a
   * constant compiled into the code -- and it is what makes "delivered at native scale" checkable.
   */
  deliveryMaxEdge: z.number().default(1568),
  /** Absolute cap on images returned by one call. Guards the context, not the algorithm. */
  maxTiles: z.number().default(64),
})

export function apply(ctx, config) {
  const cfg = { deliveryMaxEdge: 1568, maxTiles: 64, ...(config ?? {}) }
  const exec = createExecutor({ ctx, cfg })

  ctx.effect(() => {
    const eye = defineTool({
      ...makeCompoundEyeTool({ cfg }),
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            result: { type: 'string', required: true },
            tiles: { type: 'array', required: true },
            report: { type: 'object', additionalProperties: true },
            source: { type: 'object', additionalProperties: true },
            requested: { type: 'object', additionalProperties: true },
          },
        },
        render: renderTiles,
      },
      async execute(args) { return exec.run(args ?? {}) },
    })
    ctx.tools.register(eye)

    const probe = defineTool({
      ...makeProbeTool(),
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            result: { type: 'string', required: true },
            report: { type: 'object', additionalProperties: true },
            tiles: { type: 'array', required: true },
            source: { type: 'object', additionalProperties: true },
          },
        },
        render: renderText,
      },
      async execute(args) { return exec.probe(args ?? {}) },
    })
    ctx.tools.register(probe)

    ctx.logger?.info?.(`dsh-compound-eye: 2 tools registered (deliveryMaxEdge=${cfg.deliveryMaxEdge}, maxTiles=${cfg.maxTiles})`)

    return () => {
      // defineTool registrations are collected by the tools service; the effect disposer is what
      // removes them on unload. Nothing else in this plugin owns a resource.
    }
  }, 'dsh-compound-eye.tools')
}

export default { name, inject, Config, apply }
