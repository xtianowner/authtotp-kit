// Home-page shield material (from the showcase lab, candidate 4): candidate 3's dark steel, --glow fresnel rim,
// inner border, glowing keyhole, HUD bands and scan beam, plus a hologram mode (uHolo 0 → 1) for screen 2: the body
// fades, rim/bands/keyhole stay lit. Output is premultiplied alpha (the renderer blends ONE, ONE_MINUS_SRC_ALPHA).
precision highp float;

uniform vec3 cameraPosition;
uniform vec3 uGlow;
uniform vec3 uBase;
uniform float uTime;
uniform float uScanY;
uniform float uScan;
uniform float uHolo;

varying vec3 vNormal;
varying vec3 vWorldPos;
varying vec2 vLocal;
varying float vRing;
varying float vPart;

float keyhole(vec2 p) {
  float circle = length(p - vec2(0.0, 0.2)) - 0.16;
  float halfWidth = mix(0.065, 0.12, clamp((0.12 - p.y) / 0.52, 0.0, 1.0));
  float slot = max(abs(p.x) - halfWidth, max(p.y - 0.14, -0.4 - p.y));
  return min(circle, slot);
}

void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(cameraPosition - vWorldPos);
  if (!gl_FrontFacing) N = -N;
  vec3 L = normalize(vec3(-0.45, 0.65, 0.8));
  float diffuse = max(dot(N, L), 0.0);
  float spec = pow(max(dot(reflect(-L, N), V), 0.0), 36.0);
  float fresnel = pow(1.0 - max(dot(N, V), 0.0), 2.6);
  float isFace = 1.0 - step(1.5, vPart);
  float border = exp(-pow((vRing - 0.8) / 0.014, 2.0)) * isFace;
  float band = step(0.93, fract(vWorldPos.y * 7.0 - uTime * 0.35));
  float beam = exp(-pow((vWorldPos.y - uScanY) / 0.06, 2.0)) * uScan;

  // solid steel (candidate 3)
  vec3 solid = uBase * (0.55 + 0.9 * diffuse) + uGlow * fresnel * 0.85 + vec3(spec) * 0.35 + uGlow * border * 0.9;
  // hologram: light only
  float holoBand = step(0.86, fract(vWorldPos.y * 12.0 - uTime * 0.6));
  vec3 holo = uGlow * (0.035 + fresnel * 1.2 + border * 1.0 + holoBand * 0.2);

  vec3 col = mix(solid, holo, uHolo);
  if (vPart < 0.5) {
    float k = keyhole(vLocal);
    float inside = 1.0 - smoothstep(-0.004, 0.004, k);
    col = mix(col, uBase * 0.25 * (1.0 - uHolo), inside);
    col += uGlow * exp(-abs(k) * 55.0) * 1.1;
    col += uGlow * inside * 0.18 * (0.6 + 0.4 * sin(uTime * 2.0));
  }
  col += uGlow * (1.0 - isFace) * 0.28;
  col += uGlow * band * 0.06 * (1.0 - uHolo);
  col += uGlow * beam * 1.1 + vec3(beam * 0.35);

  float alpha = mix(1.0, 0.34, uHolo);
  gl_FragColor = vec4(col * alpha, alpha);
}
