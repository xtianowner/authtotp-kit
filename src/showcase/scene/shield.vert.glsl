// Home-page shield (from the showcase lab, candidate 3): world-space position/normal for fresnel + holographic bands.
attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;

uniform mat4 modelMatrix;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;

varying vec3 vNormal;
varying vec3 vWorldPos;
varying vec2 vLocal;
varying float vRing;
varying float vPart;

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorldPos = world.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vLocal = position.xy;
  vRing = uv.x;
  vPart = uv.y;
  gl_Position = projectionMatrix * viewMatrix * world;
}
