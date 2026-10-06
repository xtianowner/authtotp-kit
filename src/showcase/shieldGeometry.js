// Procedural heater shield (from the showcase lab, candidate 3): domed front/back faces built from scaled copies of
// the contour (so the fragment shader gets a 0→1 band coordinate for the inner border line) plus a side wall.
// Attributes: position (vec3), normal (vec3), uv = (band 0..1, part 0 front / 1 back / 2 side).

export const SHIELD = { width: 0.82, top: 0.92, tip: -1.06, corner: 0.14, depth: 0.12, dome: 0.2 }

export function shieldContour(samples = 40) {
  const { width: W, top: T, tip: B, corner: r } = SHIELD
  const sideTop = T - r
  const side = (u) => [W * Math.sqrt(Math.max(0, 1 - u ** 1.8)), sideTop - u * (sideTop - B)]
  const pts = []
  for (let i = 0; i <= samples; i += 1) pts.push(side(1 - i / samples)) // tip → up the right side
  for (let i = 1; i < 10; i += 1) {
    const a = (i / 10) * (Math.PI / 2)
    pts.push([W - r + r * Math.cos(a), T - r + r * Math.sin(a)])
  }
  for (let i = 0; i <= 12; i += 1) pts.push([(W - r) - (i / 12) * 2 * (W - r), T])
  for (let i = 1; i < 10; i += 1) {
    const a = Math.PI / 2 + (i / 10) * (Math.PI / 2)
    pts.push([-(W - r) + r * Math.cos(a), T - r + r * Math.sin(a)])
  }
  for (let i = 0; i < samples; i += 1) {
    const [x, y] = side(i / samples)
    pts.push([-x, y]) // down the left side, stopping before the tip
  }
  return pts // counter-clockwise seen from +z
}

export function buildShield({ rings = 12 } = {}) {
  const contour = shieldContour()
  const n = contour.length
  const { depth, dome } = SHIELD
  const cy = contour.reduce((sum, [, y]) => sum + y, 0) / n
  const positions = []
  const uvs = []
  const indices = []
  const push = (x, y, z, band, part) => {
    positions.push(x, y, z)
    uvs.push(band, part)
    return positions.length / 3 - 1
  }

  const face = (sign, part) => {
    const center = push(0, cy, sign * (depth + dome), 0, part)
    const ringStart = []
    for (let j = 1; j <= rings; j += 1) {
      const t = j / rings
      ringStart[j] = positions.length / 3
      const z = sign * (depth + dome * (1 - t * t))
      for (let k = 0; k < n; k += 1) {
        const [x, y] = contour[k]
        push(x * t, cy + (y - cy) * t, z, t, part)
      }
    }
    const tri = (a, b, c) => (sign > 0 ? indices.push(a, b, c) : indices.push(a, c, b))
    for (let k = 0; k < n; k += 1) tri(center, ringStart[1] + k, ringStart[1] + ((k + 1) % n))
    for (let j = 1; j < rings; j += 1) {
      for (let k = 0; k < n; k += 1) {
        const k2 = (k + 1) % n
        const a = ringStart[j] + k
        const b = ringStart[j] + k2
        const c = ringStart[j + 1] + k2
        const d = ringStart[j + 1] + k
        tri(a, d, c)
        tri(a, c, b)
      }
    }
  }
  face(1, 0)
  face(-1, 1)

  const front = positions.length / 3
  for (let k = 0; k < n; k += 1) push(contour[k][0], contour[k][1], depth, 1, 2)
  const back = positions.length / 3
  for (let k = 0; k < n; k += 1) push(contour[k][0], contour[k][1], -depth, 1, 2)
  for (let k = 0; k < n; k += 1) {
    const k2 = (k + 1) % n
    indices.push(front + k, back + k, back + k2)
    indices.push(front + k, back + k2, front + k2)
  }

  // Smooth normals per part (parts don't share vertices, so the rim keeps a crisp edge).
  const normals = new Float32Array(positions.length)
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = [indices[i] * 3, indices[i + 1] * 3, indices[i + 2] * 3]
    const ux = positions[b] - positions[a]; const uy = positions[b + 1] - positions[a + 1]; const uz = positions[b + 2] - positions[a + 2]
    const vx = positions[c] - positions[a]; const vy = positions[c + 1] - positions[a + 1]; const vz = positions[c + 2] - positions[a + 2]
    const nx = uy * vz - uz * vy; const ny = uz * vx - ux * vz; const nz = ux * vy - uy * vx
    for (const v of [a, b, c]) { normals[v] += nx; normals[v + 1] += ny; normals[v + 2] += nz }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1
    normals[i] /= len; normals[i + 1] /= len; normals[i + 2] /= len
  }

  return {
    position: new Float32Array(positions),
    normal: normals,
    uv: new Float32Array(uvs),
    index: positions.length / 3 > 65535 ? new Uint32Array(indices) : new Uint16Array(indices),
  }
}

/** SVG path of the same contour (for the still poster), in a 0..100 × 0..100 box. */
export function shieldPath() {
  const pts = shieldContour(24)
  const sx = (x) => (50 + x * 48).toFixed(2)
  const sy = (y) => (50 - (y + 0.07) * 48).toFixed(2)
  return `M${pts.map(([x, y]) => `${sx(x)} ${sy(y)}`).join('L')}Z`
}
