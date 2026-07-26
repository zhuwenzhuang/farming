import { createXtermSnapshotOverlays } from '@/lib/xterm'

const DISPLAY_SIZE = 840
const FILTER_SIZE = 920
const SHADOW_PX = 72
const MAP_SCALE = 640
const FIELD_INNER = 0.22
const FIELD_OUTER = 0.46
const BLUR_OFFSET_PX = 2
const SCENE_REFRESH_MIN_MS = 60_000
const SCENE_REFRESH_BLEND_MS = 1_200
const SCENE_REFRESH_MAX_MOTION = 0.40
const PET_SNAPSHOT_EXCLUDE_SELECTOR = [
  '[data-pet-ui]',
  '[data-pet-snapshot-exclude]',
  '.code-pet-black-hole-rest',
  '.code-pet-glass-rest-overlay',
].join(', ')
const DISPLAY_CAP = 1792
const RENDER_SCALE = 1.25
const INTRO_SECONDS = 15
const MIDDLE_CYCLE_SECONDS = 90
export const BLACK_HOLE_EXIT_SECONDS = 15
export const BLACK_HOLE_MANUAL_EXIT_SECONDS = 2.8
const TOKEN_AREA_MIN = 0.01
const TOKEN_AREA_MAX = 0.50
const HOLE_SIZE_DIAL = 0.02
const WORK_AREA = 0.33
const PATH_CALM = 0.014
const PATH_RUSH = 0.052

const VERTEX_SHADER = `#version 300 es
void main() {
  vec2 position = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(position * 2.0 - 1.0, 0.0, 1.0);
}`

const SHARED_SHADER = `
const float B_CRIT = 2.5980762;

float hash21(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

float wrappedNoise(vec2 p, float periodY) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float y0 = mod(i.y, periodY);
  float y1 = mod(i.y + 1.0, periodY);
  return mix(
    mix(hash21(vec2(i.x, y0)), hash21(vec2(i.x + 1.0, y0)), f.x),
    mix(hash21(vec2(i.x, y1)), hash21(vec2(i.x + 1.0, y1)), f.x),
    f.y
  );
}

vec2 rotate2d(vec2 value, float angle) {
  float c = cos(angle);
  float s = sin(angle);
  return vec2(c * value.x - s * value.y, s * value.x + c * value.y);
}

vec3 blackbody(float temperature) {
  float t = clamp(temperature, 1500.0, 40000.0) / 100.0;
  float r = t <= 66.0
    ? 1.0
    : clamp(1.292936 * pow(t - 60.0, -0.1332047), 0.0, 1.0);
  float g = t <= 66.0
    ? clamp(0.3900816 * log(t) - 0.6318414, 0.0, 1.0)
    : clamp(1.1298909 * pow(t - 60.0, -0.0755148), 0.0, 1.0);
  float b = t >= 66.0
    ? 1.0
    : (t <= 19.0
      ? 0.0
      : clamp(0.5432068 * log(t - 10.0) - 1.1962540, 0.0, 1.0));
  return vec3(r, g, b);
}

float smoother(float value) {
  float t = clamp(value, 0.0, 1.0);
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

float fieldFade(float radius) {
  return 1.0 - smoother(
    (radius - ${FIELD_INNER.toFixed(2)}) /
    ${(FIELD_OUTER - FIELD_INNER).toFixed(2)}
  );
}
`

const DISPLAY_SHADER = `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uTime;
uniform float uOpacity;
uniform float uLook;
uniform float uMass;
uniform float uDiskFeed;
uniform float uHawking;
uniform float uFinalBurst;
out vec4 outColor;

${SHARED_SHADER}

vec3 stars(vec3 direction) {
  vec2 sphere = vec2(
    atan(direction.x, -direction.z),
    asin(clamp(direction.y, -1.0, 1.0))
  );
  vec2 grid = sphere * 40.0;
  vec2 id = floor(grid);
  float h = hash21(id);
  if (h < 0.94) return vec3(0.0);
  vec2 offset = (vec2(hash21(id + 17.3), hash21(id + 31.7)) - 0.5) * 0.7;
  float spark = smoothstep(0.10, 0.0, length(fract(grid) - 0.5 - offset));
  float twinkle = 0.82 + 0.18 * sin(uTime * (0.5 + 1.4 * hash21(id + 5.1)) + 40.0 * h);
  return mix(vec3(1.0, 0.82, 0.60), vec3(0.75, 0.85, 1.0), hash21(id + 2.9))
    * spark * twinkle * ((h - 0.94) / 0.06) * 0.34;
}

vec4 evaporation(vec2 point, float baseHorizon, float horizon) {
  if (uHawking <= 0.001 && uFinalBurst <= 0.001) return vec4(0.0);
  float heat = clamp(uHawking, 0.0, 1.0);
  float burst = clamp(uFinalBurst, 0.0, 1.0);
  float distanceFromCenter = length(point);
  float q = distanceFromCenter / max(horizon, baseHorizon * 0.012);
  float thermal = exp(-q * 1.35) * pow(heat, 3.2) * (0.10 + 0.28 * heat);
  float shimmer = 0.93 + 0.07 * sin(uTime * 8.0 + q * 4.0);
  vec3 thermalColor = mix(vec3(1.0, 0.22, 0.035), vec3(0.65, 0.84, 1.0), heat);
  float radiationEnvelope =
    smoother(heat / 0.12) * (1.0 - smoother((heat - 0.90) / 0.10));
  float angle = atan(point.y, point.x);
  float leadingRadius = baseHorizon * mix(1.12, 5.55, heat);
  float leadingWidth = baseHorizon * mix(0.10, 0.22, heat);
  float leadingShell = exp(-pow(
    (distanceFromCenter - leadingRadius) / max(leadingWidth, 0.001),
    2.0
  ));
  float trailingProgress = clamp((heat - 0.12) / 0.88, 0.0, 1.0);
  float trailingRadius = baseHorizon * mix(1.0, 4.45, trailingProgress);
  float trailingShell = exp(-pow(
    (distanceFromCenter - trailingRadius) / max(baseHorizon * 0.17, 0.001),
    2.0
  ));
  float angularPackets = mix(
    0.58,
    1.0,
    pow(
      0.5 + 0.5 * sin(angle * 23.0 + q * 1.7 - uTime * 1.8),
      4.0
    )
  );
  float radialRays = pow(
    max(0.0, sin(angle * 17.0 - q * 2.2 + uTime * 1.15)),
    8.0
  ) * smoothstep(1.1, 1.8, q) * (1.0 - smoothstep(5.2, 6.6, q));
  float radiation = radiationEnvelope * (
    leadingShell * angularPackets * 0.72
    + trailingShell * angularPackets * 0.34
    + radialRays * exp(-q * 0.20) * 0.16
  );
  vec3 radiationColor = mix(
    vec3(1.0, 0.36, 0.06),
    vec3(0.62, 0.86, 1.0),
    smoother(heat)
  );
  float pulse = sin(3.14159265 * burst);
  float flashRadius = baseHorizon * mix(0.08, 0.72, burst);
  float flash = exp(-pow(distanceFromCenter / max(flashRadius, 0.001), 2.0))
    * pulse * pulse;
  vec3 color =
    thermalColor * thermal * shimmer
    + radiationColor * radiation
    + vec3(0.72, 0.88, 1.0) * flash * 2.4;
  return vec4(
    color,
    clamp(thermal * 0.65 + radiation * 0.82 + flash * 0.88, 0.0, 1.0)
  );
}

void main() {
  vec2 uv = vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y) / uResolution;
  vec2 point = uv - 0.5;
  float pointLength = length(point);
  float baseHorizon = ${(SHADOW_PX / DISPLAY_SIZE).toFixed(8)};
  float horizon = baseHorizon * max(uMass, 0.015);
  vec4 evaporationColor = evaporation(point, baseHorizon, horizon);
  float window = exp(-pow(pointLength / (7.0 * horizon), 2.0)) * fieldFade(pointLength);
  if (max(window, evaporationColor.a) < 0.002) {
    outColor = vec4(0.0);
    return;
  }

  float innerRadius = mix(2.2, 1.8, uLook);
  float outerRadius = mix(7.0, 8.0, uLook);
  float roll = mix(0.10, 0.35, uLook);
  float inclination = mix(1.52, 1.50, uLook);
  float diskOpacity = mix(0.85, 0.90, uLook);
  float doppler = mix(0.35, 0.60, uLook);
  float beam = mix(2.0, 2.5, uLook);
  float gain = mix(1.4, 2.2, uLook);
  float contrast = mix(0.5, 1.6, uLook);
  float wind = 7.0;
  float speed = 5.0;
  float exposure = mix(1.2, 1.4, uLook);
  float projection = B_CRIT / horizon;
  vec2 projected = rotate2d(vec2(point.x, -point.y), roll) * projection;
  float impact = length(projected);
  float maxImpact = outerRadius + 3.0;
  float zStart = max(14.0, outerRadius + 5.0);

  if (impact >= maxImpact) {
    vec3 direction = normalize(vec3(-(projected / impact) * (2.0 / impact), -1.0));
    vec3 starColor = stars(direction) * window;
    outColor = vec4(starColor, max(max(starColor.r, starColor.g), starColor.b) * uOpacity);
    return;
  }

  vec3 position = vec3(projected, zStart);
  vec3 velocity = vec3(0.0, 0.0, -1.0);
  float angularMomentum = dot(projected, projected);
  vec3 diskNormal = vec3(0.0, sin(inclination), cos(inclination));
  vec3 diskAxis = vec3(0.0, cos(inclination), -sin(inclination));
  vec3 emission = vec3(0.0);
  float transmittance = 1.0;
  bool captured = false;
  float previousSide = dot(position, diskNormal);
  vec3 previousPosition = position;

  for (int step = 0; step < 48; step++) {
    float radiusSquared = dot(position, position);
    if (radiusSquared < 1.0) {
      captured = true;
      break;
    }
    if (position.z < -zStart && velocity.z < 0.0) break;
    if (radiusSquared > 4.0 * zStart * zStart) break;

    float radius = sqrt(radiusSquared);
    float delta = clamp(0.16 * radius, 0.03, 1.5);
    vec3 acceleration =
      -1.5 * angularMomentum * position / (radiusSquared * radiusSquared * radius);
    velocity += acceleration * (0.5 * delta);
    position += velocity * delta;
    radiusSquared = dot(position, position);
    radius = sqrt(radiusSquared);
    acceleration =
      -1.5 * angularMomentum * position / (radiusSquared * radiusSquared * radius);
    velocity += acceleration * (0.5 * delta);

    float side = dot(position, diskNormal);
    if (side * previousSide < 0.0 && transmittance > 0.02) {
      float crossing = previousSide / (previousSide - side);
      vec3 diskPoint = mix(previousPosition, position, crossing);
      float diskRadius = length(diskPoint);
      if (diskRadius > innerRadius && diskRadius < outerRadius) {
        float band = smoothstep(innerRadius, innerRadius * 1.25, diskRadius)
          * (1.0 - smoothstep(outerRadius * 0.70, outerRadius, diskRadius));
        float phi = atan(dot(diskPoint, diskAxis), diskPoint.x);
        float turns = phi / 6.2831853;
        float kepler = pow(innerRadius / diskRadius, 1.5);
        float gravity = sqrt(max(1.0 - 1.5 / diskRadius, 0.02));
        float swirl = diskRadius * wind * 0.12 - uTime * kepler * gravity * speed * 0.38;
        float streaks =
          wrappedNoise(vec2(diskRadius * 2.8, turns * 19.0 + swirl * 3.0), 19.0) * 0.65
          + wrappedNoise(vec2(diskRadius, turns * 9.0 + swirl * 1.5 + 7.0), 9.0) * 0.35;
        streaks = 0.35 + contrast * streaks * streaks;
        vec3 gasDirection = normalize(cross(diskNormal, diskPoint));
        float beta = clamp(
          inversesqrt(max(2.0 * (diskRadius - 1.0), 0.2)),
          0.0,
          0.99
        );
        float frequencyShift = gravity / max(
          1.0 + beta * dot(gasDirection, normalize(velocity)),
          0.05
        );
        frequencyShift = mix(1.0, frequencyShift, doppler);
        float x = max(1.0 - sqrt(innerRadius / diskRadius), 0.0);
        float temperatureProfile =
          pow(innerRadius / diskRadius, 0.75) * pow(x, 0.25) / 0.488;
        vec3 color = blackbody(mix(4500.0, 5500.0, uLook) * temperatureProfile * frequencyShift);
        float density = band * streaks * uDiskFeed;
        emission += transmittance * color
          * (gain * 2.2 * density * temperatureProfile * temperatureProfile
            * pow(frequencyShift, beam));
        transmittance *= 1.0 - clamp(diskOpacity * density, 0.0, 1.0);
      }
    }
    previousSide = side;
    previousPosition = position;
  }

  if (!captured && dot(position, position) < 4.0) captured = true;
  vec3 starColor = vec3(0.0);
  float skyBlock = captured ? 1.0 : 0.0;
  if (!captured) {
    vec3 direction = normalize(velocity);
    starColor = stars(direction) * window;
    skyBlock = 1.0 - smoothstep(0.05, 0.35, -direction.z);
  }
  vec3 disk = vec3(1.0) - exp(-emission * exposure);
  float alpha = clamp(skyBlock + (1.0 - transmittance), 0.0, 1.0) * uOpacity;
  vec3 body = (starColor * transmittance + disk) * uOpacity;
  outColor = vec4(
    body + evaporationColor.rgb * (1.0 - alpha),
    max(alpha, evaporationColor.a)
  );
}`

const MAP_SHADER = `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uByte;
out vec4 outColor;

${SHARED_SHADER}

void writeMap(vec2 displacement, float activity) {
  float cap = ${MAP_SCALE.toFixed(1)} * 0.48;
  vec2 limited = cap * tanh(displacement / cap);
  vec2 packed = floor(
    clamp(0.5 + limited / ${MAP_SCALE.toFixed(1)}, 0.0, 1.0) * 65535.0 + 0.5
  );
  vec2 highByte = floor(packed / 256.0);
  vec2 lowByte = packed - highByte * 256.0;
  outColor = vec4((uByte < 0.5 ? highByte : lowByte) / 255.0, activity, 1.0);
}

void main() {
  vec2 css = vec2(
    gl_FragCoord.x / uResolution.x * ${FILTER_SIZE.toFixed(1)},
    (uResolution.y - gl_FragCoord.y) / uResolution.y * ${FILTER_SIZE.toFixed(1)}
  );
  vec2 point = (css - ${FILTER_SIZE / 2}.0) / ${DISPLAY_SIZE.toFixed(1)};
  float pointLength = length(point);
  float edge = fieldFade(pointLength);
  float horizon = ${(SHADOW_PX / DISPLAY_SIZE).toFixed(8)};
  if (pointLength < 0.00001 || edge <= 0.0) {
    writeMap(vec2(0.0), 0.0);
    return;
  }

  float projection = B_CRIT / horizon;
  vec2 projected = rotate2d(vec2(point.x, -point.y), 0.10) * projection;
  float impact = length(projected);
  float outerRadius = 7.0;
  float maxImpact = outerRadius + 3.0;
  float blendInnerImpact = maxImpact - 1.5;
  float blendOuterImpact = maxImpact + 1.5;
  float zStart = max(14.0, outerRadius + 5.0);
  vec2 sourcePoint = point;
  bool valid = false;

  float u = zStart * inversesqrt(zStart * zStart + impact * impact);
  float farDeflection = (2.0 / (projection * projection))
    / max(pointLength, 0.0001)
    * (1.29 * u + 0.07)
    * max(13.0 - 2.14 * u + 0.75, 0.0);
  vec2 farSourcePoint =
    point - point / max(pointLength, 0.00001) * farDeflection;

  if (impact <= blendOuterImpact) {
    vec3 position = vec3(projected, zStart);
    vec3 velocity = vec3(0.0, 0.0, -1.0);
    float angularMomentum = dot(projected, projected);
    bool captured = false;
    for (int step = 0; step < 48; step++) {
      float radiusSquared = dot(position, position);
      if (radiusSquared < 1.0) {
        captured = true;
        break;
      }
      if (position.z < -zStart && velocity.z < 0.0) break;
      if (radiusSquared > 4.0 * zStart * zStart) break;
      float radius = sqrt(radiusSquared);
      float delta = clamp(0.16 * radius, 0.03, 1.5);
      vec3 acceleration =
        -1.5 * angularMomentum * position / (radiusSquared * radiusSquared * radius);
      velocity += acceleration * (0.5 * delta);
      position += velocity * delta;
      radiusSquared = dot(position, position);
      radius = sqrt(radiusSquared);
      acceleration =
        -1.5 * angularMomentum * position / (radiusSquared * radiusSquared * radius);
      velocity += acceleration * (0.5 * delta);
    }
    if (!captured && dot(position, position) < 4.0) captured = true;
    if (!captured) {
      vec3 direction = normalize(velocity);
      if (direction.z < -0.05) {
        float planeDistance = (-13.0 - position.z) / direction.z;
        vec3 hitPoint = position + direction * planeDistance;
        vec2 unrotated = rotate2d(hitPoint.xy, -0.10) / projection;
        vec2 tracedSourcePoint = vec2(unrotated.x, -unrotated.y);
        // The numerical trace is most useful near the lens, while the
        // far-field approximation is much cheaper outside it. A quintic
        // blend has zero slope at both ends, so the displacement field does
        // not develop a visible radial crease where the implementations meet.
        float farMix = smoother(
          (impact - blendInnerImpact) /
          (blendOuterImpact - blendInnerImpact)
        );
        sourcePoint = mix(tracedSourcePoint, farSourcePoint, farMix);
        valid = true;
      }
    }
  }
  if (!valid && impact >= blendInnerImpact) {
    sourcePoint = farSourcePoint;
    valid = true;
  }

  vec2 displacement = valid
    ? (sourcePoint - point) * exp(-pow(pointLength / (7.0 * horizon), 2.0)) * edge
    : vec2(0.0);
  float offsetPixels = length(displacement) * ${DISPLAY_SIZE.toFixed(1)};
  writeMap(
    displacement * ${DISPLAY_SIZE.toFixed(1)},
    smoother(offsetPixels / ${BLUR_OFFSET_PX.toFixed(1)})
  );
}`

const COMPOSITOR_SHADER = `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform vec2 uCenter;
uniform float uScale;
uniform float uOpacity;
uniform float uPixelRatio;
uniform sampler2D uScene;
uniform sampler2D uSceneNext;
uniform float uSceneMix;
uniform sampler2D uHigh;
uniform sampler2D uLow;
out vec4 outColor;

vec4 scene(vec2 pixel) {
  vec2 uv = clamp(pixel / uResolution, vec2(0.0), vec2(1.0));
  vec4 current = texture(uScene, uv);
  if (uSceneMix <= 0.001) return current;
  return mix(current, texture(uSceneNext, uv), uSceneMix);
}

void main() {
  vec2 fragment = gl_FragCoord.xy;
  vec4 original = scene(fragment);
  vec2 relative = fragment - uCenter;
  float radius = length(relative) / (${DISPLAY_SIZE.toFixed(1)} * uScale);
  if (radius >= ${FIELD_OUTER.toFixed(2)} || uOpacity <= 0.001) {
    outColor = original;
    return;
  }
  vec2 mapUv = relative / (${FILTER_SIZE.toFixed(1)} * uScale) + 0.5;
  vec4 high = texture(uHigh, mapUv);
  vec4 low = texture(uLow, mapUv);
  vec2 packed = high.rg * 255.0 * 256.0 + low.rg * 255.0;
  vec2 displacement =
    (packed / 65535.0 - 0.5) * ${MAP_SCALE.toFixed(1)} * uScale * uOpacity;
  displacement.y = -displacement.y;
  vec2 samplePixel = fragment + displacement;
  float softness = high.b * uOpacity;
  vec4 sharp = scene(samplePixel);
  if (softness <= 0.01) {
    outColor = sharp;
    return;
  }
  vec2 offset = vec2(0.72) * uPixelRatio * softness;
  vec4 soft = (
    scene(samplePixel + vec2(offset.x, offset.y))
    + scene(samplePixel + vec2(-offset.x, offset.y))
    + scene(samplePixel + vec2(offset.x, -offset.y))
    + scene(samplePixel - offset)
  ) * 0.25;
  outColor = mix(sharp, soft, softness * 0.72);
}`

interface BlackHoleRendererElements {
  canvas: HTMLCanvasElement
  compositor: HTMLCanvasElement
  homeElement: () => Element | null
  onError: (message: string) => void
}

export interface BlackHolePetRenderer {
  setActive: (active: boolean) => void
  beginExit: (
    onComplete: () => void,
    durationSeconds?: number,
    returnHome?: boolean,
    elapsedSeconds?: number,
  ) => void
  destroy: () => void
}

interface EvaporationState {
  progress: number
  mass: number
  diskFeed: number
  hawking: number
  burst: number
  body: number
  lens: number
}

interface DiskLook {
  look: number
  size: number
  motion: number
  lens: number
  diskRate: number
  phase: string
}

interface Pose {
  centerX: number
  centerY: number
  scale: number
  mass: number
  bodyOpacity: number
  lensOpacity: number
}

interface DisplayRenderer {
  draw: (
    time: number,
    opacity: number,
    look: DiskLook,
    evaporation: EvaporationState,
  ) => void
  resize: (cssSize: number) => void
  destroy: () => void
}

interface CompositorRenderer {
  setScene: (image: TexImageSource) => void
  transitionScene: (image: TexImageSource, durationMs: number) => void
  draw: (pose: Pose) => void
  destroy: () => void
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
) {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('Unable to create the black-hole shader.')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || 'The black-hole shader did not compile.'
    gl.deleteShader(shader)
    throw new Error(message)
  }
  return shader
}

function createProgram(gl: WebGL2RenderingContext, fragmentSource: string) {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER)
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource)
  const program = gl.createProgram()
  if (!program) throw new Error('Unable to create the black-hole program.')
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)
  gl.deleteShader(vertex)
  gl.deleteShader(fragment)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || 'The black-hole program did not link.'
    gl.deleteProgram(program)
    throw new Error(message)
  }
  return program
}

function createDisplayRenderer(canvas: HTMLCanvasElement): DisplayRenderer {
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    antialias: false,
    premultipliedAlpha: true,
    powerPreference: 'high-performance',
  })
  if (!gl) throw new Error('WebGL 2 is required for the black-hole appearance.')

  const program = createProgram(gl, DISPLAY_SHADER)
  const resolution = gl.getUniformLocation(program, 'uResolution')
  const time = gl.getUniformLocation(program, 'uTime')
  const opacity = gl.getUniformLocation(program, 'uOpacity')
  const lookUniform = gl.getUniformLocation(program, 'uLook')
  const mass = gl.getUniformLocation(program, 'uMass')
  const diskFeed = gl.getUniformLocation(program, 'uDiskFeed')
  const hawking = gl.getUniformLocation(program, 'uHawking')
  const finalBurst = gl.getUniformLocation(program, 'uFinalBurst')
  let renderSize = 0

  gl.useProgram(program)

  return {
    resize(cssSize) {
      const pixelRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1))
      const exact = Math.min(
        DISPLAY_CAP,
        Math.max(512, Math.round(cssSize * pixelRatio * RENDER_SCALE)),
      )
      const nextSize = Math.round(exact / 16) * 16
      canvas.style.width = `${cssSize}px`
      canvas.style.height = `${cssSize}px`
      if (renderSize === nextSize) return
      renderSize = nextSize
      canvas.width = nextSize
      canvas.height = nextSize
    },
    draw(clock, alpha, look, evaporation) {
      gl.viewport(0, 0, canvas.width, canvas.height)
      gl.useProgram(program)
      gl.uniform2f(resolution, canvas.width, canvas.height)
      gl.uniform1f(time, clock)
      gl.uniform1f(opacity, alpha)
      gl.uniform1f(lookUniform, look.look)
      gl.uniform1f(mass, evaporation.mass)
      gl.uniform1f(diskFeed, evaporation.diskFeed)
      gl.uniform1f(hawking, evaporation.hawking)
      gl.uniform1f(finalBurst, evaporation.burst)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    },
    destroy() {
      gl.deleteProgram(program)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    },
  }
}

function createDisplacementMap(byte: 0 | 1) {
  const canvas = document.createElement('canvas')
  const resolution = Math.round(
    FILTER_SIZE * Math.min(2, Math.max(1, window.devicePixelRatio || 1)),
  )
  canvas.width = resolution
  canvas.height = resolution
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    antialias: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
  })
  if (!gl) throw new Error('WebGL 2 is required for black-hole refraction.')
  const program = createProgram(gl, MAP_SHADER)
  gl.useProgram(program)
  gl.uniform2f(gl.getUniformLocation(program, 'uResolution'), resolution, resolution)
  gl.uniform1f(gl.getUniformLocation(program, 'uByte'), byte)
  gl.viewport(0, 0, resolution, resolution)
  gl.drawArrays(gl.TRIANGLES, 0, 3)
  gl.deleteProgram(program)
  return canvas
}

async function createSceneImage() {
  const width = window.innerWidth
  const height = window.innerHeight
  const pixelRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1))
  const captureStartedAt = performance.now()
  const { default: html2canvas } = await import('html2canvas')
  const removeXtermOverlays = createXtermSnapshotOverlays()
  let excludedElementCount = 0
  let remainingExcludedElementCount = 0
  try {
    const image = await html2canvas(document.body, {
      allowTaint: false,
      backgroundColor: getComputedStyle(document.body).backgroundColor || '#101418',
      foreignObjectRendering: false,
      height,
      ignoreElements: element => (
        element.closest(PET_SNAPSHOT_EXCLUDE_SELECTOR) !== null
        || element.tagName === 'SCRIPT'
        || element.tagName === 'NOSCRIPT'
        || element.tagName === 'VIDEO'
        || element.tagName === 'BROWSER-MCP-CONTAINER'
      ),
      imageTimeout: 500,
      logging: false,
      onclone: clonedDocument => {
        const clonedBody = clonedDocument.body
        const excludedElements = Array.from(
          clonedDocument.querySelectorAll(PET_SNAPSHOT_EXCLUDE_SELECTOR),
        )
        excludedElementCount = excludedElements.length
        excludedElements.forEach(element => element.remove())
        remainingExcludedElementCount = clonedDocument
          .querySelectorAll(PET_SNAPSHOT_EXCLUDE_SELECTOR)
          .length
        clonedBody.style.width = `${width}px`
        clonedBody.style.height = `${height}px`
        clonedBody.style.margin = '0'
        clonedBody.style.overflow = 'hidden'
        clonedDocument
          .querySelectorAll<HTMLElement>('[data-pet-xterm-snapshot]')
          .forEach(overlay => {
            overlay.style.visibility = 'visible'
          })
      },
      removeContainer: true,
      scale: pixelRatio,
      scrollX: 0,
      scrollY: 0,
      useCORS: true,
      width,
      windowHeight: height,
      windowWidth: width,
      x: 0,
      y: 0,
    })
    image.dataset.captureMs = String(Math.round(performance.now() - captureStartedAt))
    image.dataset.excludedPetElements = String(excludedElementCount)
    image.dataset.remainingPetElements = String(remainingExcludedElementCount)
    return image
  } finally {
    removeXtermOverlays()
  }
}

function createCompositorRenderer(
  canvas: HTMLCanvasElement,
  highMap: HTMLCanvasElement,
  lowMap: HTMLCanvasElement,
): CompositorRenderer {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    premultipliedAlpha: false,
    powerPreference: 'high-performance',
  })
  if (!gl) throw new Error('WebGL 2 is required for black-hole refraction.')
  const program = createProgram(gl, COMPOSITOR_SHADER)
  const resolution = gl.getUniformLocation(program, 'uResolution')
  const center = gl.getUniformLocation(program, 'uCenter')
  const scale = gl.getUniformLocation(program, 'uScale')
  const opacity = gl.getUniformLocation(program, 'uOpacity')
  const pixelRatioUniform = gl.getUniformLocation(program, 'uPixelRatio')
  const sceneMix = gl.getUniformLocation(program, 'uSceneMix')
  const textures: WebGLTexture[] = []

  const texture = (unit: number, source: TexImageSource) => {
    const result = gl.createTexture()
    if (!result) throw new Error('Unable to create the black-hole scene texture.')
    textures.push(result)
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, result)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      source,
    )
    return result
  }

  gl.useProgram(program)
  let sceneTexture = texture(0, highMap)
  texture(1, highMap)
  texture(2, lowMap)
  let nextSceneTexture = texture(3, highMap)
  highMap
    .getContext('webgl2')
    ?.getExtension('WEBGL_lose_context')
    ?.loseContext()
  lowMap
    .getContext('webgl2')
    ?.getExtension('WEBGL_lose_context')
    ?.loseContext()
  gl.uniform1i(gl.getUniformLocation(program, 'uScene'), 0)
  gl.uniform1i(gl.getUniformLocation(program, 'uSceneNext'), 3)
  gl.uniform1i(gl.getUniformLocation(program, 'uHigh'), 1)
  gl.uniform1i(gl.getUniformLocation(program, 'uLow'), 2)
  let transition: {
    startedAt: number
    durationMs: number
    captureMs: string
  } | null = null
  let sceneGeneration = 0

  const uploadScene = (
    unit: number,
    target: WebGLTexture,
    image: TexImageSource,
  ) => {
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, target)
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      image,
    )
  }

  return {
    setScene(image) {
      sceneGeneration += 1
      canvas.dataset.sceneGeneration = String(sceneGeneration)
      const pixelRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1))
      canvas.width = Math.round(window.innerWidth * pixelRatio)
      canvas.height = Math.round(window.innerHeight * pixelRatio)
      canvas.style.width = `${window.innerWidth}px`
      canvas.style.height = `${window.innerHeight}px`
      uploadScene(0, sceneTexture, image)
      canvas.dataset.captureMs = image instanceof HTMLCanvasElement
        ? image.dataset.captureMs
        : ''
      canvas.dataset.excludedPetElements = image instanceof HTMLCanvasElement
        ? (image.dataset.excludedPetElements ?? '')
        : ''
      canvas.dataset.remainingPetElements = image instanceof HTMLCanvasElement
        ? (image.dataset.remainingPetElements ?? '')
        : ''
      canvas.style.opacity = '1'
    },
    transitionScene(image, durationMs) {
      sceneGeneration += 1
      canvas.dataset.sceneGeneration = String(sceneGeneration)
      const uploadStartedAt = performance.now()
      uploadScene(3, nextSceneTexture, image)
      canvas.dataset.uploadMs = String(Math.round(
        (performance.now() - uploadStartedAt) * 10,
      ) / 10)
      canvas.dataset.excludedPetElements = image instanceof HTMLCanvasElement
        ? (image.dataset.excludedPetElements ?? '')
        : ''
      canvas.dataset.remainingPetElements = image instanceof HTMLCanvasElement
        ? (image.dataset.remainingPetElements ?? '')
        : ''
      transition = {
        startedAt: performance.now(),
        durationMs: Math.max(1, durationMs),
        captureMs: image instanceof HTMLCanvasElement
          ? (image.dataset.captureMs ?? '')
          : '',
      }
      canvas.dataset.refreshState = 'blending'
    },
    draw(pose) {
      if (!canvas.width || !canvas.height) return
      const pixelRatio = canvas.width / window.innerWidth
      let transitionAmount = 0
      if (transition) {
        transitionAmount = smoother(
          (performance.now() - transition.startedAt) / transition.durationMs,
        )
        if (transitionAmount >= 1) {
          const previousSceneTexture = sceneTexture
          sceneTexture = nextSceneTexture
          nextSceneTexture = previousSceneTexture
          gl.activeTexture(gl.TEXTURE0)
          gl.bindTexture(gl.TEXTURE_2D, sceneTexture)
          gl.activeTexture(gl.TEXTURE3)
          gl.bindTexture(gl.TEXTURE_2D, nextSceneTexture)
          canvas.dataset.captureMs = transition.captureMs
          canvas.dataset.refreshState = 'idle'
          transition = null
          transitionAmount = 0
        }
      }
      gl.viewport(0, 0, canvas.width, canvas.height)
      gl.useProgram(program)
      gl.uniform2f(resolution, canvas.width, canvas.height)
      gl.uniform2f(
        center,
        pose.centerX * pixelRatio,
        (window.innerHeight - pose.centerY) * pixelRatio,
      )
      gl.uniform1f(scale, pose.scale * pose.mass * pixelRatio)
      gl.uniform1f(opacity, pose.lensOpacity)
      gl.uniform1f(pixelRatioUniform, pixelRatio)
      gl.uniform1f(sceneMix, transitionAmount)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    },
    destroy() {
      textures.forEach(item => gl.deleteTexture(item))
      gl.deleteProgram(program)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    },
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function smoother(value: number) {
  const t = clamp(value, 0, 1)
  return t * t * t * (t * (t * 6 - 15) + 10)
}

function homePoint(homeElement: () => Element | null) {
  const element = homeElement()
  if (!element) {
    return { x: 28, y: window.innerHeight - 28 }
  }
  const rect = element.getBoundingClientRect()
  return {
    x: rect.left + rect.width * 0.72,
    y: rect.top + rect.height * 0.5,
  }
}

function mix(a: number, b: number, amount: number) {
  return a + (b - a) * amount
}

function adaptiveScale(progress: number) {
  const aspect = window.innerWidth / window.innerHeight
  const minimum = Math.sqrt(TOKEN_AREA_MIN * aspect / Math.PI)
  const maximum = Math.sqrt(TOKEN_AREA_MAX * aspect / Math.PI)
  const horizon = mix(minimum, maximum, progress) * (HOLE_SIZE_DIAL / 0.08)
  return horizon * window.innerHeight / SHADOW_PX
}

const BIRTH_STATE: DiskLook = {
  phase: 'birth',
  look: 0,
  size: 0.72,
  motion: 0.06,
  lens: 0.58,
  diskRate: 0.42,
}

const CYCLE_STATES = [
  { phase: 'glide', progress: 0, look: 0.18, size: 0.94, motion: 0.34, lens: 0.88, diskRate: 0.72 },
  { phase: 'warm', progress: 0.17, look: 0.42, size: 0.97, motion: 0.46, lens: 0.93, diskRate: 0.88 },
  { phase: 'flare', progress: 0.35, look: 0.76, size: 1, motion: 0.72, lens: 1, diskRate: 1.20 },
  { phase: 'inferno', progress: 0.53, look: 0.96, size: 0.99, motion: 0.84, lens: 1, diskRate: 1.38 },
  { phase: 'cool', progress: 0.70, look: 0.48, size: 0.95, motion: 0.38, lens: 0.90, diskRate: 0.82 },
  { phase: 'quiet', progress: 0.86, look: 0.08, size: 0.91, motion: 0.16, lens: 0.80, diskRate: 0.58 },
  { phase: 'glide', progress: 1, look: 0.18, size: 0.94, motion: 0.34, lens: 0.88, diskRate: 0.72 },
] as const

function macroAt(elapsed: number): DiskLook {
  const intro = clamp(elapsed / INTRO_SECONDS, 0, 1)
  if (intro < 1) {
    const amount = smoother(intro)
    const target = CYCLE_STATES[0]!
    return {
      phase: 'birth',
      look: mix(BIRTH_STATE.look, target.look, amount),
      size: mix(BIRTH_STATE.size, target.size, amount),
      motion: mix(BIRTH_STATE.motion, target.motion, amount),
      lens: mix(BIRTH_STATE.lens, target.lens, amount),
      diskRate: mix(BIRTH_STATE.diskRate, target.diskRate, amount),
    }
  }

  const cycleTime = elapsed - INTRO_SECONDS
  const progress = (cycleTime % MIDDLE_CYCLE_SECONDS) / MIDDLE_CYCLE_SECONDS
  let index = 0
  while (
    index < CYCLE_STATES.length - 2
    && progress > CYCLE_STATES[index + 1]!.progress
  ) index += 1
  const first = CYCLE_STATES[index]!
  const second = CYCLE_STATES[index + 1]!
  const amount = smoother(
    (progress - first.progress) / (second.progress - first.progress),
  )
  const theta = progress * Math.PI * 2
  const wave =
    0.70 * Math.sin(theta) ** 3
    + 0.30 * Math.sin(theta * 2) ** 3
  const secondWave =
    0.65 * Math.sin(theta) ** 3
    + 0.35 * Math.sin(theta * 2) ** 3
  return {
    phase: amount < 0.5 ? first.phase : second.phase,
    look: clamp(mix(first.look, second.look, amount) + wave * 0.025, 0, 1),
    size: Math.min(1, mix(first.size, second.size, amount) * (1 + secondWave * 0.010)),
    motion: clamp(mix(first.motion, second.motion, amount) + secondWave * 0.025, 0, 1),
    lens: clamp(mix(first.lens, second.lens, amount) + wave * 0.012, 0, 1),
    diskRate: mix(first.diskRate, second.diskRate, amount) * (1 + secondWave * 0.025),
  }
}

function seedValue(seed: number, point: number, channel: number) {
  let value = (point | 0) ^ seed ^ Math.imul(channel + 1, 0x9e3779b9)
  value = Math.imul(value ^ (value >>> 16), 0x21f0aaad)
  value = Math.imul(value ^ (value >>> 15), 0x735a2d97)
  return ((value ^ (value >>> 15)) >>> 0) / 2147483647.5 - 1
}

function noise(seed: number, value: number, channel: number) {
  const point = Math.floor(value)
  const amount = smoother(value - point)
  return mix(
    seedValue(seed, point, channel),
    seedValue(seed, point + 1, channel),
    amount,
  )
}

function randomField(seed: number, elapsed: number, pace: number, channel: number) {
  return {
    x:
      0.72 * noise(seed, elapsed * pace, channel)
      + 0.28 * noise(seed, elapsed * pace * 2.13 + 11.7, channel + 1),
    y:
      0.72 * noise(seed, elapsed * pace * 0.91 + 7.3, channel + 2)
      + 0.28 * noise(seed, elapsed * pace * 1.87 + 19.1, channel + 3),
  }
}

function evaporationAt(progress: number): EvaporationState {
  if (progress <= 0) {
    return {
      progress: 0,
      mass: 1,
      diskFeed: 1,
      hawking: 0,
      burst: 0,
      body: 1,
      lens: 1,
    }
  }
  const evaporation = clamp((progress - 0.18) / 0.72, 0, 1)
  return {
    progress,
    mass: Math.max(0.055, (1 - evaporation) ** (1 / 3)),
    diskFeed: 1 - smoother(progress / 0.30),
    hawking: smoother((progress - 0.18) / 0.69),
    burst: clamp((progress - 0.87) / 0.13, 0, 1),
    body: 1 - smoother((progress - 0.97) / 0.03),
    lens: 1 - smoother((progress - 0.93) / 0.05),
  }
}

function activePose(
  elapsed: number,
  look: DiskLook,
  seed: number,
  homeElement: () => Element | null,
): Pose {
  const progress = clamp(elapsed / INTRO_SECONDS, 0, 1)
  const width = window.innerWidth
  const height = window.innerHeight
  const aspect = width / height
  const scale = adaptiveScale(progress) * look.size
  const horizon = SHADOW_PX * scale / height
  const home = homePoint(homeElement)
  const homeUv = { x: home.x / width, y: home.y / height }
  const margin = Math.min(
    horizon * mix(1.45, 0.90, progress),
    0.5 * (1 - WORK_AREA - 0.03),
  )
  const xPadding = margin / aspect
  const low = { x: Math.min(xPadding, 0.5), y: margin }
  const high = {
    x: Math.max(0.5, 1 - xPadding),
    y: Math.max(margin, 1 - (WORK_AREA + 0.03 + margin)),
  }
  const corner = {
    x: clamp(homeUv.x, low.x, high.x),
    y: clamp(homeUv.y, low.y, high.y),
  }
  const reach = mix(0.06, 1, progress)
  const roamLow = { x: mix(corner.x, low.x, reach), y: low.y }
  const roamHigh = { x: high.x, y: mix(corner.y, high.y, reach) }
  const room = {
    x: Math.max((roamHigh.x - roamLow.x) * 0.5, 0),
    y: Math.max((roamHigh.y - roamLow.y) * 0.5, 0),
  }
  const wobbleBase = (0.010 + 0.030 * progress) * mix(0.65, 1.15, look.motion)
  const wobble = {
    x: Math.min(wobbleBase, Math.max(room.x * 0.35, 0.006)),
    y: Math.min(wobbleBase, Math.max(room.y * 0.35, 0.006)),
  }
  const amplitude = {
    x: Math.max(room.x - wobble.x, 0),
    y: Math.max(room.y - wobble.y, 0),
  }
  const calm = randomField(seed, elapsed, PATH_CALM, 0)
  const rush = randomField(seed, elapsed, PATH_RUSH, 4)
  const wander = {
    x: mix(calm.x, rush.x, look.motion),
    y: mix(calm.y, rush.y, look.motion),
  }
  const micro = randomField(seed, elapsed, 0.11, 8)
  const roam = {
    x: (roamLow.x + roamHigh.x) * 0.5 + wander.x * amplitude.x + wobble.x * micro.x,
    y: (roamLow.y + roamHigh.y) * 0.5 + wander.y * amplitude.y + wobble.y * micro.y,
  }
  const departure = smoother(progress)
  const visibility = smoother(clamp(elapsed / (INTRO_SECONDS * 0.55), 0, 1))
  return {
    centerX: mix(homeUv.x, roam.x, departure) * width,
    centerY: mix(homeUv.y, roam.y, departure) * height,
    scale,
    mass: 1,
    bodyOpacity: visibility,
    lensOpacity: visibility * look.lens,
  }
}

export function createBlackHolePetRenderer({
  canvas,
  compositor: compositorCanvas,
  homeElement,
  onError,
}: BlackHoleRendererElements): BlackHolePetRenderer {
  let display: DisplayRenderer
  let compositor: CompositorRenderer
  try {
    display = createDisplayRenderer(canvas)
    compositor = createCompositorRenderer(
      compositorCanvas,
      createDisplacementMap(0),
      createDisplacementMap(1),
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    onError(message)
    return {
      setActive() {},
      beginExit(onComplete) {
        onComplete()
      },
      destroy() {},
    }
  }

  let active = true
  let destroyed = false
  let sceneReady = false
  let exitingAt: number | null = null
  let exitDuration = BLACK_HOLE_EXIT_SECONDS
  let exitReturnsHome = true
  let exitComplete: (() => void) | null = null
  let requestId = 0
  let lastClockAt = 0
  let diskClock = 18.5
  let nextSceneRefreshAt = Number.POSITIVE_INFINITY
  let sceneRefreshInFlight = false
  const startedAt = performance.now()
  const roamSeed = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0

  const clearSchedule = () => {
    if (requestId) cancelAnimationFrame(requestId)
    requestId = 0
  }

  const schedule = () => {
    if (
      destroyed
      || !active
      || !sceneReady
      || document.hidden
      || requestId
    ) return
    requestId = requestAnimationFrame(frame)
  }

  const applyPose = (pose: Pose) => {
    const pixelRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1))
    const snap = (value: number) => Math.round(value * pixelRatio) / pixelRatio
    const size = snap(DISPLAY_SIZE * pose.scale)
    canvas.style.left = `${snap(pose.centerX - size / 2)}px`
    canvas.style.top = `${snap(pose.centerY - size / 2)}px`
    canvas.style.opacity = String(pose.bodyOpacity)
    display.resize(size)
  }

  const refreshScene = () => {
    if (
      destroyed
      || sceneRefreshInFlight
      || exitingAt !== null
      || document.hidden
    ) return
    sceneRefreshInFlight = true
    compositorCanvas.dataset.refreshState = 'capturing'
    void createSceneImage()
      .then(image => {
        if (destroyed) return
        compositor.transitionScene(image, SCENE_REFRESH_BLEND_MS)
        nextSceneRefreshAt = performance.now() + SCENE_REFRESH_MIN_MS
      })
      .catch(error => {
        if (destroyed) return
        compositorCanvas.dataset.refreshState = 'retry-wait'
        compositorCanvas.dataset.refreshError = error instanceof Error
          ? error.message
          : String(error)
        nextSceneRefreshAt = performance.now() + SCENE_REFRESH_MIN_MS
      })
      .finally(() => {
        sceneRefreshInFlight = false
      })
  }

  function frame(now: number) {
    requestId = 0
    if (destroyed || !active || !sceneReady || document.hidden) return
    const elapsed = (now - startedAt) / 1000
    const look = macroAt(elapsed)
    if (
      now >= nextSceneRefreshAt
      && look.motion <= SCENE_REFRESH_MAX_MOTION
    ) {
      refreshScene()
    }
    let evaporation = evaporationAt(0)
    let pose = activePose(elapsed, look, roamSeed, homeElement)

    if (exitingAt !== null) {
      const progress = clamp((now - exitingAt) / (exitDuration * 1000), 0, 1)
      compositorCanvas.dataset.exitProgress = progress.toFixed(4)
      evaporation = evaporationAt(progress)
      const exitElapsed = (exitingAt - startedAt) / 1000
      const frozenTime =
        exitElapsed + 0.45 * (1 - Math.exp(-(now - exitingAt) / 450))
      const frozenLook = macroAt(frozenTime)
      pose = activePose(frozenTime, frozenLook, roamSeed, homeElement)
      const home = homePoint(homeElement)
      const returning = exitReturnsHome
        ? smoother((progress - 0.64) / 0.36)
        : 0
      pose = {
        ...pose,
        centerX: mix(pose.centerX, home.x, returning),
        centerY: mix(pose.centerY, home.y, returning),
        mass: evaporation.mass,
        bodyOpacity: evaporation.body,
        lensOpacity: evaporation.lens * frozenLook.lens,
      }
      if (progress >= 1) {
        clearSchedule()
        const complete = exitComplete
        exitComplete = null
        complete?.()
        return
      }
    }

    if (lastClockAt) {
      const dilation = mix(
        look.diskRate,
        0.08,
        smoother(evaporation.progress / 0.30),
      )
      diskClock += Math.min(0.1, (now - lastClockAt) / 1000) * dilation
    }
    lastClockAt = now
    applyPose(pose)
    compositor.draw(pose)
    display.draw(diskClock, pose.bodyOpacity, look, evaporation)
    schedule()
  }

  void createSceneImage()
    .then(image => {
      if (destroyed) return
      compositor.setScene(image)
      sceneReady = true
      nextSceneRefreshAt = performance.now() + SCENE_REFRESH_MIN_MS
      compositorCanvas.dataset.refreshState = 'idle'
      schedule()
    })
    .catch(error => {
      if (destroyed) return
      onError(error instanceof Error ? error.message : String(error))
    })

  const onVisibilityChange = () => {
    if (document.hidden) {
      clearSchedule()
      lastClockAt = 0
    } else if (active) {
      schedule()
    }
  }
  document.addEventListener('visibilitychange', onVisibilityChange)
  const testWindow = window as Window & {
    __FARMING_E2E__?: boolean
    __farmingBlackHolePetTest?: { refreshScene: () => void }
  }
  const testApi = { refreshScene }
  if (testWindow.__FARMING_E2E__) {
    testWindow.__farmingBlackHolePetTest = testApi
  }

  return {
    setActive(nextActive) {
      active = nextActive
      if (!active) {
        clearSchedule()
        lastClockAt = 0
      } else {
        schedule()
      }
    },
    beginExit(
      onComplete,
      durationSeconds = BLACK_HOLE_EXIT_SECONDS,
      returnHome = true,
      elapsedSeconds = 0,
    ) {
      if (exitingAt !== null || destroyed) return
      exitDuration = Math.max(0.3, durationSeconds)
      exitingAt = performance.now()
        - clamp(elapsedSeconds, 0, exitDuration) * 1000
      exitReturnsHome = returnHome
      exitComplete = onComplete
      schedule()
    },
    destroy() {
      destroyed = true
      clearSchedule()
      document.removeEventListener('visibilitychange', onVisibilityChange)
      if (testWindow.__farmingBlackHolePetTest === testApi) {
        delete testWindow.__farmingBlackHolePetTest
      }
      compositorCanvas.style.opacity = '0'
      compositor.destroy()
      display.destroy()
    },
  }
}
