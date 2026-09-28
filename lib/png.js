/**
 * PNG codec -- decode and encode, exactly what this plugin needs and nothing more.
 *
 * WHY hand-written (same reason as the companion plugin): this package has no image library in its
 * dependency tree. A codec that ships zero dependencies is a codec that cannot break because a
 * transitive dependency moved. It decodes 8-bit greyscale / RGB / RGBA, non-interlaced, which is
 * what screenshot and crop pipelines produce; anything else is refused BY NAME rather than
 * half-decoded into wrong pixels.
 *
 * The encoder always writes RGBA8. Lossless is deliberate: this plugin's whole subject is whether
 * pixels survive the delivery path, so it must not be the thing that blurs them.
 */
import { inflateSync, deflateSync } from 'node:zlib'

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** @returns {{w:number,h:number,ch:number,data:Buffer}} RGB(A) or grey pixels, 8 bit. */
export function decodePng(buf) {
  if (!Buffer.isBuffer(buf)) throw new Error('decodePng: expected a Buffer')
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('decodePng: not a PNG (bad signature)')
  let pos = 8, w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0
  const idat = []
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4)
      bitDepth = data[8]; colorType = data[9]; interlace = data[12]
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    pos += 12 + len
  }
  if (!w || !h) throw new Error('decodePng: missing IHDR')
  if (bitDepth !== 8) throw new Error(`decodePng: unsupported bit depth ${bitDepth} (only 8)`)
  if (interlace !== 0) throw new Error('decodePng: interlaced PNG is not supported')
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType]
  if (!ch) throw new Error(`decodePng: unsupported color type ${colorType} (palette is not supported)`)
  const raw = inflateSync(Buffer.concat(idat))
  const stride = w * ch
  const out = Buffer.alloc(h * stride)
  let rp = 0
  const paeth = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
  }
  for (let y = 0; y < h; y++) {
    if (rp >= raw.length) throw new Error('decodePng: truncated image data')
    const ft = raw[rp++]
    if (ft > 4) throw new Error(`decodePng: bad filter type ${ft} on row ${y}`)
    const line = raw.subarray(rp, rp + stride); rp += stride
    const cur = out.subarray(y * stride, (y + 1) * stride)
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0, v = line[x]
      let val
      if (ft === 0) val = v
      else if (ft === 1) val = v + a
      else if (ft === 2) val = v + b
      else if (ft === 3) val = v + ((a + b) >> 1)
      else val = v + paeth(a, b, c)
      cur[x] = val & 0xff
    }
  }
  return { w, h, ch, data: out }
}

let CRC_TABLE = null
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE
  CRC_TABLE = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    CRC_TABLE[n] = c
  }
  return CRC_TABLE
}
function crc32(buf) {
  const T = crcTable()
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = T[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
/** Encode RGBA8 (ch=4) or RGB8 (ch=3) into a PNG buffer. */
export function encodePng({ w, h, ch = 4, data }) {
  if (ch !== 3 && ch !== 4) throw new Error(`encodePng: unsupported channel count ${ch}`)
  const colorType = ch === 4 ? 6 : 2
  const stride = w * ch
  const raw = Buffer.alloc(h * (stride + 1))
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0 // filter: none (pixels are already final; filtering would only add code)
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([PNG_SIG, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

/** Read width/height out of a PNG header without decoding pixels. */
export function pngSize(buf) {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('pngSize: not a PNG')
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
}

/** The three grey-level conventions this plugin cares about, in one place. */
export const LUMA = (r, g, b) => (r * 299 + g * 587 + b * 114) / 1000
