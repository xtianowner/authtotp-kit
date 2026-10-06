// Home-page background pass (from the showcase lab, candidate 4): candidate 2's folded light sheets, toned down and
// parked just above the HUD floor's horizon like an aurora, plus sparse stars in the sky. Output is premultiplied
// (alpha = brightest channel) so the CSS grid, floor and scanlines behind the transparent canvas stay visible.
// One hue (--glow) + white highlights.
precision highp float;

uniform float uTime;
uniform vec2 uRes;
uniform vec3 uGlow;
uniform float uPulse;
uniform float uNarrow;
uniform float uLevel;
varying vec2 vUv;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) {
    v += a * vnoise(p);
    p = p * 2.07 + 11.3;
    a *= 0.5;
  }
  return v;
}

vec2 sheet(vec2 p, float t, float yC, float amp, float freq, float phase, float thick) {
  float x = p.x;
  float wave = sin(x * freq + t + phase) + 0.45 * sin(x * freq * 2.13 - t * 1.31 + phase * 1.7);
  float y = yC + amp * wave + 0.05 * (vnoise(vec2(x * 0.9 + t * 0.4, phase)) - 0.5);
  float twist = 0.5 + 0.5 * cos(x * freq * 0.62 - t * 0.74 + phase);
  float w = thick * (0.16 + 1.15 * twist);
  float d = (p.y - y) / w;
  float body = exp(-d * d * 1.7) * (0.3 + 0.7 * twist);
  float e = d - 0.8;
  float edge = exp(-e * e * 9.0) * (1.0 - 0.55 * twist);
  return vec2(body, edge);
}

void main() {
  float aspect = uRes.x / uRes.y;
  vec2 p = vec2((vUv.x - 0.5) * aspect, vUv.y);
  float t = uTime * 0.14;
  float horizon = mix(0.455, 0.34, uNarrow);
  float freq = mix(1.4, 2.3, uNarrow);

  vec2 a = sheet(p, t, horizon + 0.035, 0.045, freq, 0.0, mix(0.075, 0.06, uNarrow));
  vec2 b = sheet(p, t * 0.8, horizon, 0.035, freq * 0.72, 2.4, 0.05);
  float tex = fbm(p * vec2(5.0, 11.0) + vec2(t * 2.2, -t));
  float grain = hash12(floor(gl_FragCoord.xy) + floor(uTime * 12.0) * 17.0);

  float body = a.x + 0.55 * b.x;
  float edge = a.y + 0.4 * b.y;
  float center = 1.25 - 1.5 * uPulse;
  float sweep = exp(-(vUv.x - center) * (vUv.x - center) * 14.0) * uPulse;
  float intensity = body * (0.4 + 0.8 * tex) * (0.72 + 0.4 * grain) + edge * (0.75 + 0.25 * grain);
  intensity *= uLevel * (1.0 + 1.1 * sweep);
  // nothing sinks below the floor's horizon
  intensity *= smoothstep(horizon - 0.07, horizon - 0.01, vUv.y);

  vec3 col = uGlow * intensity * 0.8 + vec3(1.0) * pow(max(intensity - 0.45, 0.0), 1.4) * 0.5;

  float s = hash12(floor(gl_FragCoord.xy / 2.0));
  float star = step(0.9984, s) * (0.4 + 0.6 * (0.5 + 0.5 * sin(uTime * 1.7 + s * 80.0)));
  col += vec3(star) * 0.5 * smoothstep(horizon - 0.02, horizon + 0.08, vUv.y) * (1.0 - min(body, 1.0));

  float alpha = clamp(max(col.r, max(col.g, col.b)), 0.0, 1.0);
  gl_FragColor = vec4(min(col, vec3(alpha)), alpha);
}
