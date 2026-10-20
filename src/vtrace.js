/**
 * vtracer 后端：用 @neplex/vectorizer 做高质量矢量化，并产出与原版
 * trace-image.js 完全一致的 `drawing` 契约（供 client.js 的渐进绘制回放使用）。
 *
 * 为什么要有这个文件：
 *   原版自研描边（trace-image.js）路线是「调色板量化 + k-means → 连通域 →
 *   marching squares → Douglas-Peucker 折线」，没有曲线拟合、工作分辨率有上限。
 *   vtracer 走的是「分层颜色聚类 → 三次贝塞尔样条」，并支持每通道位深控制，
 *   在 1920 源上实测 PSNR 可到 38~46 dB（原版约 18~26 dB）。
 *
 * 契约对齐（见策划案 §6.5）：
 *   drawing = {
 *     viewBox: [0, 0, width, height],
 *     fills:  ['#rrggbb', ...],            // 每层填充色
 *     steps:  [{ layer, d, area }, ...]    // 按 area 降序 → 先大块后细节
 *   }
 *   客户端 traceDrawingLayers() 按 layer 把 d 累加进对应 fill，绘制回放完全复用。
 */
import { vectorize, ColorMode, Hierarchical, PathSimplifyMode } from '@neplex/vectorizer'
import { deflateSync } from 'node:zlib'

/** 保真档位 → vtracer 参数。数值均为本机实测校准（见策划案 §2.3 / §5.1）。 */
export const VTRACE_LEVELS = Object.freeze({
  fast: {
    label: '快速',
    colorPrecision: 6, filterSpeckle: 2, layerDifference: 8,
    mode: 'spline', pathPrecision: 2, renderWidth: 0,
    note: '约 18 dB，体积最小',
  },
  hifi: {
    label: '高保真',
    colorPrecision: 8, filterSpeckle: 0, layerDifference: 8,
    mode: 'spline', pathPrecision: 2, renderWidth: 0,
    note: '约 38 dB，推荐',
  },
  pixel: {
    label: '像素级',
    colorPrecision: 8, filterSpeckle: 0, layerDifference: 1,
    mode: 'none', pathPrecision: 1, renderWidth: 0,
    note: '约 46 dB，轮廓贴像素边界，体积最大',
  },
})

export const VTRACE_LEVEL_NAMES = Object.keys(VTRACE_LEVELS)

const MODE_MAP = {
  spline: PathSimplifyMode.Spline,
  polygon: PathSimplifyMode.Polygon,
  none: PathSimplifyMode.None,
}

/** 把档位 + 用户覆盖项合成 vtracer 配置。 */
export function resolveVtraceConfig(raw = {}) {
  const levelName = VTRACE_LEVEL_NAMES.includes(raw.level) ? raw.level : 'hifi'
  const level = VTRACE_LEVELS[levelName]
  const num = (value, fallback, min, max) => {
    const n = Number(value)
    if (!Number.isFinite(n)) return fallback
    return Math.min(max, Math.max(min, n))
  }
  const mode = Object.prototype.hasOwnProperty.call(MODE_MAP, raw.mode) ? raw.mode : level.mode
  return {
    level: levelName,
    colorPrecision: num(raw.colorPrecision, level.colorPrecision, 4, 8),
    filterSpeckle: num(raw.filterSpeckle, level.filterSpeckle, 0, 16),
    layerDifference: num(raw.layerDifference, level.layerDifference, 1, 64),
    mode,
    pathPrecision: num(raw.pathPrecision, level.pathPrecision, 0, 4),
    renderWidth: num(raw.renderWidth, level.renderWidth, 0, 8192),
  }
}

/** 组装 @neplex/vectorizer 的 Config 对象。 */
export function toVectorizerConfig(config) {
  return {
    colorMode: ColorMode.Color,
    hierarchical: Hierarchical.Stacked,
    mode: MODE_MAP[config.mode] ?? PathSimplifyMode.Spline,
    cornerThreshold: 60,
    lengthThreshold: 4,
    maxIterations: 10,
    spliceThreshold: 45,
    filterSpeckle: config.filterSpeckle,
    colorPrecision: config.colorPrecision,
    layerDifference: config.layerDifference,
    pathPrecision: config.pathPrecision,
  }
}

/** RGBA8 raster → PNG buffer（vtracer 入口只收编码后的图片字节）。 */
export function rasterToPngBuffer(raster) {
  const { width, height, data } = raster
  if (!width || !height) throw new Error('栅格尺寸无效')
  if (!data || data.length !== width * height * 4) throw new Error('原始像素长度无效（需 RGBA8）')
  // 用 PNG 的最小编码：filter=0 每行 + zlib 压缩。不依赖第三方编码器。
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0 // filter type 0 (None)
    Buffer.from(data.buffer ?? data, data.byteOffset + y * stride, stride)
      .copy(raw, y * (stride + 1) + 1)
  }
  return {
    width,
    height,
    png: encodePng(width, height, raw),
  }
}

/** 极简 PNG 编码（8bit RGBA，无交错）。只为本模块服务，不做通用实现。 */
function encodePng(width, height, rawWithFilter) {
  const compressed = deflateSync(rawWithFilter, { level: 6 })
  const chunks = []
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  chunks.push(sig)

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // adaptive
  ihdr[12] = 0 // no interlace
  chunks.push(makeChunk('IHDR', ihdr))
  chunks.push(makeChunk('IDAT', compressed))
  chunks.push(makeChunk('IEND', Buffer.alloc(0)))
  return Buffer.concat(chunks)
}

function makeChunk(type, payload) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(payload.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const body = Buffer.concat([typeBuf, payload])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body) >>> 0, 0)
  return Buffer.concat([len, body, crc])
}

let CRC_TABLE = null
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256)
    for (let n = 0; n < 256; n += 1) {
      let c = n
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      CRC_TABLE[n] = c
    }
  }
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** 从 path 的 d 里粗算面积（鞋带公式，贝塞尔按控制点近似）。只用于排序，不参与几何。 */
export function estimatePathArea(d) {
  const tokens = String(d).match(/[MLCQZmlcqz]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || []
  let area = 0
  let cx = 0
  let cy = 0
  let startX = 0
  let startY = 0
  let i = 0
  let cmd = 'M'
  const num = () => Number(tokens[i++])
  while (i < tokens.length) {
    const token = tokens[i]
    if (/^[MLCQZmlcqz]$/i.test(token)) { cmd = token; i += 1; if (/^z$/i.test(cmd)) { cx = startX; cy = startY; continue } }
    const rel = cmd === cmd.toLowerCase()
    if (cmd === 'M' || cmd === 'L' || cmd === 'm' || cmd === 'l') {
      let x = num()
      let y = num()
      if (rel) { x += cx; y += cy }
      if (cmd === 'M' || cmd === 'm') { startX = x; startY = y }
      area += cx * y - x * cy
      cx = x; cy = y
      if (cmd === 'M') cmd = 'L'
      else if (cmd === 'm') cmd = 'l'
    } else if (cmd === 'C' || cmd === 'c') {
      const x1 = num(); const y1 = num(); const x2 = num(); const y2 = num(); const x = num(); const y = num()
      const ax = rel ? cx + x1 : x1
      const ay = rel ? cy + y1 : y1
      const bx = rel ? cx + x2 : x2
      const by = rel ? cy + y2 : y2
      const ex = rel ? cx + x : x
      const ey = rel ? cy + y : y
      area += cx * ay - ax * cy
      area += ax * by - bx * ay
      area += bx * ey - ex * by
      cx = ex; cy = ey
    } else if (cmd === 'Q' || cmd === 'q') {
      const x1 = num(); const y1 = num(); const x = num(); const y = num()
      const ax = rel ? cx + x1 : x1
      const ay = rel ? cy + y1 : y1
      const ex = rel ? cx + x : x
      const ey = rel ? cy + y : y
      area += cx * ay - ax * cy
      area += ax * ey - ex * ay
      cx = ex; cy = ey
    } else if (cmd === 'Z' || cmd === 'z') {
      area += cx * startY - startX * cy
      cx = startX; cy = startY
      cmd = 'M'
    } else { i += 1 }
  }
  return Math.abs(area) / 2
}

/**
 * 解析 vtracer 输出 SVG 的 <path>，按 fill 分组为层，产出 drawing 契约。
 * vtracer 的洞与外轮廓在同一条 d 内（nonzero），因此一条 path 就是一个「区域」，
 * 直接对应原版 drawing.steps 的一条 step。
 *
 * 层数收敛（关键）：vtracer 因渐变会产生上万种精确色。原版按「调色板颜色」分层（几十层）。
 * 客户端 traceDrawingLayers() 是每个 fill 建一条 <path>，层数过多会让 DOM 爆炸，
 * 所以这里把颜色按 maxLayers 量化为有限调色板（按面积加权的中位切分）。
 */
export function buildDrawingFromSvg(svg, width, height, options = {}) {
  const paths = []
  const re = /<path\b([^>]*)\/?>/gi
  let m
  while ((m = re.exec(svg)) !== null) {
    const attrs = m[1]
    const dMatch = /\sd\s*=\s*"([^"]*)"/i.exec(attrs) || /\sd\s*=\s*'([^']*)'/i.exec(attrs)
    if (!dMatch || !dMatch[1]) continue
    const fillMatch = /\bfill\s*=\s*"([^"]*)"/i.exec(attrs) || /\bfill\s*=\s*'([^']*)'/i.exec(attrs)
    let fill = fillMatch ? fillMatch[1].trim() : ''
    if (!fill || fill === 'none' || fill === 'transparent') continue
    if (!fill.startsWith('#')) {
      const rgb = /rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i.exec(fill)
      if (rgb) fill = '#' + [rgb[1], rgb[2], rgb[3]].map((v) => Number(v).toString(16).padStart(2, '0')).join('')
      else continue
    }
    paths.push({ d: dMatch[1], fill: fill.toLowerCase() })
  }
  if (paths.length === 0) return { viewBox: [0, 0, width, height], fills: [], steps: [] }

  const maxLayers = Math.max(8, Math.min(256, Number(options.maxLayers) || 48))

  // 每色面积 → 量化调色板（按面积降序保留主要颜色，其余并入最近的保留色）
  const areaByFill = new Map()
  for (const p of paths) {
    const a = estimatePathArea(p.d)
    areaByFill.set(p.fill, (areaByFill.get(p.fill) || 0) + a)
  }
  const ranked = Array.from(areaByFill.entries()).sort((a, b) => b[1] - a[1])
  const keep = ranked.slice(0, maxLayers).map(([hex]) => hex)
  const keepRgb = keep.map((hex) => [
    parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16),
  ])
  const nearest = (hex) => {
    const r = parseInt(hex.slice(1, 3), 16)
    const g = parseInt(hex.slice(3, 5), 16)
    const b = parseInt(hex.slice(5, 7), 16)
    let best = 0
    let bestD = Infinity
    for (let i = 0; i < keepRgb.length; i += 1) {
      const [kr, kg, kb] = keepRgb[i]
      const dr = r - kr; const dg = g - kg; const db = b - kb
      const dist = dr * dr + dg * dg + db * db
      if (dist < bestD) { bestD = dist; best = i }
    }
    return keep[best]
  }

  const fillOrder = []
  const byFill = new Map()
  for (const p of paths) {
    const target = areaByFill.has(p.fill) && keep.includes(p.fill) ? p.fill : nearest(p.fill)
    if (!byFill.has(target)) { byFill.set(target, []); fillOrder.push(target) }
    byFill.get(target).push(p)
  }

  const steps = []
  fillOrder.forEach((fill, layer) => {
    for (const p of byFill.get(fill)) steps.push({ layer, d: p.d, area: estimatePathArea(p.d) })
  })
  steps.sort((a, b) => b.area - a.area) // 先大块，后细节（与原版一致）
  return { viewBox: [0, 0, width, height], fills: fillOrder, steps }
}

/**
 * 主入口：RGBA8 raster → { svg, drawing, metrics }
 * 与 trace-image.js 的 traceRasterForToolbar(raster, { includeDrawing:true }) 对齐。
 */
export async function traceRasterWithVtracer(raster, raw = {}) {
  const config = resolveVtraceConfig(raw)
  const started = Date.now()
  const decoded = rasterToPngBuffer(raster)
  const vectorized = await vectorize(decoded.png, toVectorizerConfig(config))
  const vectorMs = Date.now() - started

  // 渲染宽度：0 表示保持源尺寸；否则用 resvg 输出位图（供需要位图的路径/预览）
  let svg = vectorized
  let renderedPng = null
  if (config.renderWidth > 0) {
    const { Resvg } = await import('@resvg/resvg-js')
    const resvg = new Resvg(svg, {
      fitTo: { mode: 'width', value: Math.min(8192, Math.max(16, Math.round(config.renderWidth))) },
      background: raw.background === false ? undefined : '#ffffff',
    })
    renderedPng = resvg.render().asPng()
  }

  const drawing = raw.includeDrawing === true
    ? buildDrawingFromSvg(svg, raster.width, raster.height, { maxLayers: raw.maxLayers })
    : null
  return {
    svg,
    ...(drawing ? { drawing } : {}),
    ...(renderedPng ? { png: renderedPng } : {}),
    metrics: {
      engine: 'vtracer',
      level: config.level,
      colorPrecision: config.colorPrecision,
      filterSpeckle: config.filterSpeckle,
      layerDifference: config.layerDifference,
      mode: config.mode,
      pathPrecision: config.pathPrecision,
      rasterSize: { width: raster.width, height: raster.height },
      svgChars: svg.length,
      pathCount: drawing ? drawing.steps.length : null,
      layerCount: drawing ? drawing.fills.length : null,
      vectorMs,
      renderMs: renderedPng ? Date.now() - started - vectorMs : 0,
    },
  }
}
