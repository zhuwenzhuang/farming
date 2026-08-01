import { createXtermSnapshotOverlays } from '@/lib/xterm'
import type { SnapdomPlugin } from '@zumer/snapdom'

const DISPLAY_SIZE = 840
const FILTER_SIZE = 920
const SHADOW_PX = 72
const MAP_SCALE = 640
const FIELD_INNER = 0.22
const FIELD_OUTER = 0.46
const INITIAL_SCENE_RETRY_MIN_MS = 1_000
const INITIAL_SCENE_RETRY_MAX_MS = 10_000
const PET_SNAPSHOT_EXCLUDE_SELECTORS = [
  '[data-pet-ui]',
  '[data-pet-snapshot-exclude]',
  '.code-pet-black-hole-rest',
  '.code-pet-glass-rest-overlay',
]
const PET_SNAPSHOT_EXCLUDE_SELECTOR = PET_SNAPSHOT_EXCLUDE_SELECTORS.join(', ')
const FILE_ICON_SELECTOR = 'img.code-file-type-icon'
const SCENE_CAPTURE_TARGET_SCALE = 2.5
const SCENE_CAPTURE_MAX_PIXELS = 20_000_000
const SCENE_CAPTURE_MAX_DIMENSION = 8_192
const DISPLAY_CAP = 1792
const INTRO_SECONDS = 15
const MIDDLE_CYCLE_SECONDS = 90
export const BLACK_HOLE_EXIT_SECONDS = 15
export const BLACK_HOLE_MANUAL_EXIT_SECONDS = 4.8
export const BLACK_HOLE_HOME_ATTRACTION_SECONDS = 60
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

float filteredWrappedNoise(vec2 p, float periodY) {
  float value = wrappedNoise(p, periodY);
  float footprint = max(length(dFdx(p)), length(dFdy(p)));
  float retainedDetail = 1.0 - smoothstep(0.30, 0.95, footprint);
  return mix(0.5, value, retainedDetail);
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
uniform float uTemperature;
uniform float uInclination;
uniform float uRoll;
uniform float uInnerRadius;
uniform float uOuterRadius;
uniform float uDiskOpacity;
uniform float uDoppler;
uniform float uBeam;
uniform float uGain;
uniform float uContrast;
uniform float uWind;
uniform float uSpeed;
uniform float uExposure;
uniform float uStarField;
uniform float uFilamentDetail;
uniform float uMass;
uniform float uDiskFeed;
uniform float uHawking;
uniform float uFinalBurst;
uniform float uFieldScale;
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
    * spark * twinkle * ((h - 0.94) / 0.06) * 0.34 * uStarField;
}

vec4 evaporation(vec2 point, float baseHorizon, float horizon) {
  if (uHawking <= 0.001 && uFinalBurst <= 0.001) return vec4(0.0);
  float heat = clamp(uHawking, 0.0, 1.0);
  float release = clamp(uFinalBurst, 0.0, 1.0);
  float distanceFromCenter = length(point);
  float pixel = 1.5 / (uResolution.x * uFieldScale);
  float q = distanceFromCenter / max(horizon, baseHorizon * 0.018);
  float heatEnvelope = smoother(heat / 0.10) * (1.0 - smoother(release));
  vec3 heatColor = mix(
    vec3(1.0, 0.48, 0.12),
    vec3(0.72, 0.90, 1.0),
    smoother(heat)
  );

  float photonRadius = horizon * mix(1.10, 1.34, heat);
  float photonWidth = max(pixel, horizon * mix(0.075, 0.13, heat));
  float photonRing = exp(-pow(
    (distanceFromCenter - photonRadius) / photonWidth,
    2.0
  ));
  float secondaryRing = exp(-pow(
    (distanceFromCenter - photonRadius - photonWidth * 2.35)
      / max(pixel, photonWidth * 0.55),
    2.0
  )) * mix(0.12, 0.34, heat);
  float corona = exp(-q * 2.45) * pow(heat, 2.2) * 0.22;

  float releaseProgress = smoother(release);
  float echoRadius = baseHorizon * mix(0.12, 5.0, releaseProgress);
  float echoWidth = max(pixel * 1.25, baseHorizon * mix(0.085, 0.026, releaseProgress));
  float echoEnvelope =
    smoother(release / 0.10) * pow(max(1.0 - release, 0.0), 0.72);
  float echoRing = exp(-pow(
    (distanceFromCenter - echoRadius) / echoWidth,
    2.0
  )) * echoEnvelope;

  float flashEnvelope = exp(-pow((release - 0.16) / 0.12, 2.0));
  float flashRadius = baseHorizon * mix(0.12, 0.42, smoother(release / 0.35));
  float flash = exp(-pow(
    distanceFromCenter / max(flashRadius, pixel),
    2.0
  )) * flashEnvelope;
  vec3 color =
    heatColor * heatEnvelope * (photonRing + secondaryRing + corona)
    + vec3(0.76, 0.91, 1.0) * echoRing * 1.35
    + vec3(0.90, 0.96, 1.0) * flash * 2.8;
  return vec4(
    color,
    clamp(
      heatEnvelope * (photonRing * 0.90 + secondaryRing * 0.55 + corona)
        + echoRing * 0.78
        + flash * 0.92,
      0.0,
      1.0
    )
  );
}

void main() {
  vec2 uv = vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y) / uResolution;
  vec2 point = (uv - 0.5) / uFieldScale;
  float effectiveResolution = uResolution.x * uFieldScale;
  float pointLength = length(point);
  float baseHorizon = ${(SHADOW_PX / DISPLAY_SIZE).toFixed(8)};
  float horizon = baseHorizon * max(uMass, 0.015);
  vec4 evaporationColor = evaporation(point, baseHorizon, horizon);
  float window = exp(-pow(pointLength / (7.0 * horizon), 2.0)) * fieldFade(pointLength);
  if (max(window, evaporationColor.a) < 0.002) {
    outColor = vec4(0.0);
    return;
  }

  float innerRadius = uInnerRadius;
  float outerRadius = uOuterRadius;
  float roll = uRoll;
  float inclination = uInclination;
  float diskOpacity = uDiskOpacity;
  float doppler = uDoppler;
  float beam = uBeam;
  float gain = uGain;
  float contrast = uContrast;
  float wind = uWind;
  float speed = uSpeed;
  float exposure = uExposure;
  float projection = B_CRIT / horizon;
  vec2 projected = rotate2d(vec2(point.x, -point.y), roll) * projection;
  float impact = length(projected);
  float maxImpact = outerRadius + 3.0;
  float zStart = max(14.0, outerRadius + 5.0);

  if (impact >= maxImpact) {
    vec3 direction = normalize(vec3(-(projected / impact) * (2.0 / impact), -1.0));
    vec3 starColor = stars(direction) * window;
    float starAlpha = max(max(starColor.r, starColor.g), starColor.b) * uOpacity;
    outColor = vec4(
      starColor + evaporationColor.rgb * (1.0 - starAlpha),
      max(starAlpha, evaporationColor.a)
    );
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
        float fineFilament = filteredWrappedNoise(
          vec2(
            diskRadius * 2.8 + 0.24 * sin(phi * 3.0 - swirl * 0.22),
            turns * 19.0 + swirl * 3.0 + diskRadius * 0.72
          ),
          19.0
        );
        float broadFilament = filteredWrappedNoise(
          vec2(
            diskRadius * 1.35 + 0.38 * sin(phi * 2.0 + swirl * 0.16),
            turns * 8.0 + swirl * 1.35 - diskRadius * 0.55
          ),
          8.0
        );
        float flow = mix(broadFilament, fineFilament, uFilamentDetail);
        // Squaring the blended octaves is what gives the disk its filament
        // dynamic range (~5.6:1 at contrast 1.6). Remapping onto a narrow band
        // around 1.0 instead flattens every preset into the same smooth haze
        // and makes the contrast dial nearly inert.
        float streaks = 0.35 + contrast * flow * flow;
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
        vec3 color = blackbody(uTemperature * temperatureProfile * frequencyShift);
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
  float shadowPixel = max(0.004, 1.25 * projection / effectiveResolution);
  float shadowCoverage =
    1.0 - smoothstep(B_CRIT - shadowPixel, B_CRIT + shadowPixel, impact);
  float tracedCapture = captured ? 1.0 : 0.0;
  float analyticEdge = 1.0 - smoothstep(
    shadowPixel,
    shadowPixel * 3.0,
    abs(impact - B_CRIT)
  );
  float skyBlock = mix(tracedCapture, shadowCoverage, analyticEdge);
  if (!captured) {
    vec3 direction = normalize(velocity);
    starColor = stars(direction) * window;
    skyBlock = max(
      skyBlock,
      1.0 - smoothstep(0.05, 0.35, -direction.z)
    );
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
  writeMap(
    displacement * ${DISPLAY_SIZE.toFixed(1)},
    edge
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
uniform sampler2D uHigh;
uniform sampler2D uLow;
out vec4 outColor;

vec2 sceneUv(vec2 pixel) {
  return clamp(pixel / uResolution, vec2(0.0), vec2(1.0));
}

vec2 lensDisplacement(vec2 relative) {
  vec2 mapUv = relative / (${FILTER_SIZE.toFixed(1)} * uScale) + 0.5;
  vec2 packed = texture(uHigh, mapUv).rg * 255.0 * 256.0
    + texture(uLow, mapUv).rg * 255.0;
  vec2 displacement =
    (packed / 65535.0 - 0.5) * ${MAP_SCALE.toFixed(1)} * uScale * uOpacity;
  return vec2(displacement.x, -displacement.y);
}

vec4 encodeSrgb(vec4 linear) {
  vec3 low = linear.rgb * 12.92;
  vec3 high = 1.055 * pow(max(linear.rgb, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
  return vec4(
    mix(high, low, step(linear.rgb, vec3(0.0031308))),
    linear.a
  );
}

void main() {
  vec2 fragment = gl_FragCoord.xy;
  vec2 relative = fragment - uCenter;
  float radius = length(relative) / (${DISPLAY_SIZE.toFixed(1)} * uScale);
  if (radius >= ${FIELD_OUTER.toFixed(2)} || uOpacity <= 0.001) {
    outColor = encodeSrgb(texture(uScene, sceneUv(fragment)));
    return;
  }

  vec2 displacement = lensDisplacement(relative);
  vec2 samplePixel = fragment + displacement;

  // The lens field is radial, so one forward sample reconstructs both axes of
  // its local mapping footprint without four extra displacement-map lookups.
  float pixels = max(length(relative), 1.0);
  vec2 radial = relative / pixels;
  vec2 tangent = vec2(-radial.y, radial.x);
  float stride = max(1.0, uPixelRatio);
  float delta = dot(displacement, radial);
  float deltaAhead = dot(
    lensDisplacement(relative + radial * stride),
    radial
  );
  float radialScale = 1.0 + (deltaAhead - delta) / stride;
  float tangentScale = 1.0 + delta / pixels;
  vec2 dSdx =
    radialScale * radial.x * radial + tangentScale * tangent.x * tangent;
  vec2 dSdy =
    radialScale * radial.y * radial + tangentScale * tangent.y * tangent;

  outColor = encodeSrgb(textureGrad(
    uScene,
    sceneUv(samplePixel),
    dSdx / uResolution,
    dSdy / uResolution
  ));
}`

interface BlackHoleRendererElements {
  canvas: HTMLCanvasElement
  compositor: HTMLCanvasElement
  homeElement: () => Element | null
  onError: (message: string) => void
  onReady: () => void
}

export interface BlackHolePetRenderer {
  setActive: (active: boolean) => void
  setRestUntil: (restUntil: number) => void
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
  temperature: number
  inclination: number
  roll: number
  innerRadius: number
  outerRadius: number
  diskOpacity: number
  doppler: number
  beam: number
  gain: number
  contrast: number
  wind: number
  speed: number
  exposure: number
  starField: number
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
  canvasCssSize: () => number
  destroy: () => void
}

interface CompositorRenderer {
  setScene: (image: TexImageSource) => void
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
  const preserveForVisualRegression = Boolean((
    window as Window & { __FARMING_E2E__?: boolean }
  ).__FARMING_E2E__)
  // DISPLAY_SHADER already weights emitted radiance by coverage. Asking the
  // browser to premultiply it again would dim low-opacity disks twice.
  const glContext = canvas.getContext('webgl2', {
    alpha: true,
    antialias: false,
    premultipliedAlpha: true,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: preserveForVisualRegression,
  })
  if (!glContext) throw new Error('WebGL 2 is required for the black-hole appearance.')
  const gl = glContext
  canvas.dataset.filamentSampling = 'screen-space'

  const program = createProgram(gl, DISPLAY_SHADER)
  const resolution = gl.getUniformLocation(program, 'uResolution')
  const time = gl.getUniformLocation(program, 'uTime')
  const opacity = gl.getUniformLocation(program, 'uOpacity')
  const temperature = gl.getUniformLocation(program, 'uTemperature')
  const inclination = gl.getUniformLocation(program, 'uInclination')
  const roll = gl.getUniformLocation(program, 'uRoll')
  const innerRadius = gl.getUniformLocation(program, 'uInnerRadius')
  const outerRadius = gl.getUniformLocation(program, 'uOuterRadius')
  const diskOpacity = gl.getUniformLocation(program, 'uDiskOpacity')
  const doppler = gl.getUniformLocation(program, 'uDoppler')
  const beam = gl.getUniformLocation(program, 'uBeam')
  const gain = gl.getUniformLocation(program, 'uGain')
  const contrast = gl.getUniformLocation(program, 'uContrast')
  const wind = gl.getUniformLocation(program, 'uWind')
  const speed = gl.getUniformLocation(program, 'uSpeed')
  const exposure = gl.getUniformLocation(program, 'uExposure')
  const starField = gl.getUniformLocation(program, 'uStarField')
  const filamentDetailUniform = gl.getUniformLocation(program, 'uFilamentDetail')
  const mass = gl.getUniformLocation(program, 'uMass')
  const diskFeed = gl.getUniformLocation(program, 'uDiskFeed')
  const hawking = gl.getUniformLocation(program, 'uHawking')
  const finalBurst = gl.getUniformLocation(program, 'uFinalBurst')
  const fieldScaleUniform = gl.getUniformLocation(program, 'uFieldScale')
  let renderSize = 0
  let cssCanvasSize = 0
  let fieldScale = 1
  let filamentDetail = 0.65
  let verificationPixels = new Uint8Array()
  let nextVerificationAt = 0
  let maximumVerificationInkPixels = 0
  let maximumVerificationCoveredSectors = 0
  const gpuTimer = preserveForVisualRegression
    ? gl.getExtension('EXT_disjoint_timer_query_webgl2')
    : null
  const pendingGpuQueries: WebGLQuery[] = []
  const gpuFrameTimes: number[] = []
  if (preserveForVisualRegression) {
    canvas.dataset.radiationProbe = 'armed'
    canvas.dataset.gpuTimer = gpuTimer ? 'warming' : 'unavailable'
  }

  gl.useProgram(program)

  function resolveGpuQueries() {
    if (!gpuTimer) return
    while (pendingGpuQueries.length > 0) {
      const query = pendingGpuQueries[0]
      if (!query || !gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) break
      pendingGpuQueries.shift()
      const disjoint = gl.getParameter(gpuTimer.GPU_DISJOINT_EXT)
      const elapsedNanoseconds = Number(gl.getQueryParameter(query, gl.QUERY_RESULT))
      gl.deleteQuery(query)
      if (disjoint || !Number.isFinite(elapsedNanoseconds)) continue
      gpuFrameTimes.push(elapsedNanoseconds / 1_000_000)
      if (gpuFrameTimes.length > 120) gpuFrameTimes.shift()
    }
    if (gpuFrameTimes.length < 24) return
    const ordered = [...gpuFrameTimes].sort((left, right) => left - right)
    const p95 = ordered[Math.ceil(ordered.length * 0.95) - 1] ?? 0
    const mean = gpuFrameTimes.reduce((sum, value) => sum + value, 0)
      / gpuFrameTimes.length
    canvas.dataset.gpuTimer = 'sampled'
    canvas.dataset.gpuSamples = String(gpuFrameTimes.length)
    canvas.dataset.gpuMeanMs = mean.toFixed(3)
    canvas.dataset.gpuP95Ms = p95.toFixed(3)
  }

  return {
    resize(cssSize) {
      const pixelRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1))
      const idealDevice = Math.max(512, Math.round(cssSize * pixelRatio))
      // Keep the backing-to-CSS ratio at exactly 1/n. The field breathes inside
      // a coarse allocation so the browser never applies a drifting resampler.
      const divisor = Math.max(1, Math.ceil(idealDevice / DISPLAY_CAP))
      const step = 64
      const backing = Math.min(
        DISPLAY_CAP,
        Math.ceil(idealDevice / divisor / step) * step,
      )
      const nextCssSize = (backing * divisor) / pixelRatio
      fieldScale = clamp(cssSize / nextCssSize, 0.05, 1)
      filamentDetail = divisor > 1 ? 0.5 : 0.65
      if (cssCanvasSize !== nextCssSize) {
        cssCanvasSize = nextCssSize
        canvas.style.width = `${nextCssSize}px`
        canvas.style.height = `${nextCssSize}px`
      }
      if (renderSize === backing) return
      renderSize = backing
      canvas.width = backing
      canvas.height = backing
    },
    canvasCssSize() {
      return cssCanvasSize
    },
    draw(clock, alpha, look, evaporation) {
      resolveGpuQueries()
      gl.viewport(0, 0, canvas.width, canvas.height)
      gl.useProgram(program)
      gl.uniform2f(resolution, canvas.width, canvas.height)
      gl.uniform1f(time, clock)
      gl.uniform1f(opacity, alpha)
      gl.uniform1f(temperature, look.temperature)
      gl.uniform1f(inclination, look.inclination)
      gl.uniform1f(roll, look.roll)
      gl.uniform1f(innerRadius, look.innerRadius)
      gl.uniform1f(outerRadius, look.outerRadius)
      gl.uniform1f(diskOpacity, look.diskOpacity)
      gl.uniform1f(doppler, look.doppler)
      gl.uniform1f(beam, look.beam)
      gl.uniform1f(gain, look.gain)
      gl.uniform1f(contrast, look.contrast)
      gl.uniform1f(wind, look.wind)
      gl.uniform1f(speed, look.speed)
      gl.uniform1f(exposure, look.exposure)
      gl.uniform1f(starField, look.starField)
      gl.uniform1f(filamentDetailUniform, filamentDetail)
      gl.uniform1f(mass, evaporation.mass)
      gl.uniform1f(diskFeed, evaporation.diskFeed)
      gl.uniform1f(hawking, evaporation.hawking)
      gl.uniform1f(finalBurst, evaporation.burst)
      gl.uniform1f(fieldScaleUniform, fieldScale)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      const gpuQuery = gpuTimer && pendingGpuQueries.length < 8
        ? gl.createQuery()
        : null
      if (gpuQuery && gpuTimer) {
        gl.beginQuery(gpuTimer.TIME_ELAPSED_EXT, gpuQuery)
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      if (gpuQuery && gpuTimer) {
        gl.endQuery(gpuTimer.TIME_ELAPSED_EXT)
        pendingGpuQueries.push(gpuQuery)
      }
      if (
        preserveForVisualRegression
        && evaporation.hawking > 0.02
        && performance.now() >= nextVerificationAt
      ) {
        const requiredLength = canvas.width * canvas.height * 4
        if (verificationPixels.length !== requiredLength) {
          verificationPixels = new Uint8Array(requiredLength)
        }
        gl.readPixels(
          0,
          0,
          canvas.width,
          canvas.height,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          verificationPixels,
        )
        const centerX = canvas.width / 2
        const centerY = canvas.height / 2
        const fieldSize = Math.min(canvas.width, canvas.height) * fieldScale
        const innerRadius = fieldSize * 0.09
        const outerRadius = fieldSize * 0.49
        const sectors = new Uint16Array(48)
        let inkPixels = 0
        for (let y = 0; y < canvas.height; y += 2) {
          for (let x = 0; x < canvas.width; x += 2) {
            const dx = x + 0.5 - centerX
            const dy = y + 0.5 - centerY
            const radius = Math.hypot(dx, dy)
            if (radius < innerRadius || radius > outerRadius) continue
            const offset = (y * canvas.width + x) * 4
            const alpha = verificationPixels[offset + 3] ?? 0
            const luminance = (
              (verificationPixels[offset] ?? 0)
              + (verificationPixels[offset + 1] ?? 0)
              + (verificationPixels[offset + 2] ?? 0)
            ) / 3
            if (alpha < 18 || luminance < 28) continue
            inkPixels += 1
            const angle = Math.atan2(dy, dx) + Math.PI
            const sector = Math.min(47, Math.floor(angle / (Math.PI * 2) * 48))
            sectors[sector] = (sectors[sector] ?? 0) + 1
          }
        }
        const coveredSectors = Array.from(sectors).filter(value => value >= 3).length
        maximumVerificationInkPixels = Math.max(maximumVerificationInkPixels, inkPixels)
        maximumVerificationCoveredSectors = Math.max(
          maximumVerificationCoveredSectors,
          coveredSectors,
        )
        canvas.dataset.radiationInkPixels = String(maximumVerificationInkPixels)
        canvas.dataset.radiationCoveredSectors = String(maximumVerificationCoveredSectors)
        canvas.dataset.radiationProbe = 'sampled'
        nextVerificationAt = performance.now() + 120
      }
    },
    destroy() {
      for (const query of pendingGpuQueries) gl.deleteQuery(query)
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

function rasterizeVisibleFileIcons() {
  const pixelRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1))
  const sources = new Map<string, string>()
  let visibleCount = 0

  document.querySelectorAll<HTMLImageElement>(FILE_ICON_SELECTOR).forEach(image => {
    const rect = image.getBoundingClientRect()
    if (
      rect.width <= 0
      || rect.height <= 0
      || rect.right <= 0
      || rect.bottom <= 0
      || rect.left >= window.innerWidth
      || rect.top >= window.innerHeight
    ) return

    visibleCount += 1
    const source = image.currentSrc || image.src
    if (
      !source
      || sources.has(source)
      || !image.complete
      || image.naturalWidth <= 0
      || image.naturalHeight <= 0
    ) return

    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(rect.width * pixelRatio))
    canvas.height = Math.max(1, Math.round(rect.height * pixelRatio))
    const context = canvas.getContext('2d')
    if (!context) return

    try {
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      sources.set(source, canvas.toDataURL('image/png'))
    } catch {
      // Keep the original source when a browser refuses to rasterize an image.
    }
  })

  return { sources, visibleCount }
}

function sceneCaptureScale(width: number, height: number) {
  const pixelLimit = Math.sqrt(
    SCENE_CAPTURE_MAX_PIXELS / Math.max(1, width * height),
  )
  const dimensionLimit = SCENE_CAPTURE_MAX_DIMENSION
    / Math.max(1, width, height)
  const available = Math.min(
    SCENE_CAPTURE_TARGET_SCALE,
    pixelLimit,
    dimensionLimit,
  )
  return Math.max(0.5, Math.floor(available * 8) / 8)
}

async function createSceneImage() {
  const testWindow = window as Window & {
    __FARMING_E2E__?: boolean
    __farmingBlackHoleCaptureFailures?: number
  }
  if (
    testWindow.__FARMING_E2E__
    && (testWindow.__farmingBlackHoleCaptureFailures ?? 0) > 0
  ) {
    testWindow.__farmingBlackHoleCaptureFailures = Math.max(
      0,
      (testWindow.__farmingBlackHoleCaptureFailures ?? 0) - 1,
    )
    throw new Error('Synthetic initial black-hole snapshot failure.')
  }
  const width = window.innerWidth
  const height = window.innerHeight
  const captureScale = sceneCaptureScale(width, height)
  const captureStartedAt = performance.now()
  const { snapdom } = await import('@zumer/snapdom')
  const backgroundColor = getComputedStyle(document.body).backgroundColor
    || '#101418'
  const removeXtermOverlays = createXtermSnapshotOverlays()
  const fileIcons = rasterizeVisibleFileIcons()
  const excludedElementCount = document
    .querySelectorAll(PET_SNAPSHOT_EXCLUDE_SELECTOR)
    .length
  let remainingExcludedElementCount = 0
  let rasterizedFileIconCount = 0
  const clonedBodyBackground = backgroundColor
  const snapshotPlugin: SnapdomPlugin = {
    name: 'farming-black-hole-snapshot',
    afterClone(context) {
      const clone = context.clone
      if (!clone) return
      remainingExcludedElementCount = clone
        .querySelectorAll(PET_SNAPSHOT_EXCLUDE_SELECTOR)
        .length
      clone
        .querySelectorAll<HTMLElement>('[data-pet-xterm-snapshot]')
        .forEach(overlay => {
          overlay.style.visibility = 'visible'
        })
      clone
        .querySelectorAll<HTMLImageElement>(FILE_ICON_SELECTOR)
        .forEach(image => {
          const source = image.currentSrc || image.src
          const rasterizedSource = fileIcons.sources.get(source)
          if (!rasterizedSource) return
          image.removeAttribute('srcset')
          image.src = rasterizedSource
          rasterizedFileIconCount += 1
        })
    },
  }
  try {
    const image = await snapdom.toCanvas(document.body, {
      backgroundColor,
      cache: 'disabled',
      clip: 'viewport',
      compress: false,
      dpr: captureScale,
      embedFonts: true,
      exclude: [
        ...PET_SNAPSHOT_EXCLUDE_SELECTORS,
        'script',
        'noscript',
        'video',
        'browser-mcp-container',
      ],
      excludeMode: 'remove',
      outerTransforms: false,
      plugins: [snapshotPlugin],
      scale: 1,
    })
    image.dataset.captureMs = String(Math.round(performance.now() - captureStartedAt))
    image.dataset.captureEngine = 'snapdom'
    image.dataset.captureScale = captureScale.toFixed(3)
    image.dataset.excludedPetElements = String(excludedElementCount)
    image.dataset.remainingPetElements = String(remainingExcludedElementCount)
    image.dataset.visibleFileIcons = String(fileIcons.visibleCount)
    image.dataset.rasterizedFileIcons = String(rasterizedFileIconCount)
    image.dataset.clonedBodyBackground = clonedBodyBackground
    const context = image.getContext('2d', { willReadFrequently: true })
    if (context) {
      const pixel = context.getImageData(0, 0, 1, 1).data
      image.dataset.cornerLuminance = String(Math.round(
        0.2126 * (pixel[0] ?? 0)
        + 0.7152 * (pixel[1] ?? 0)
        + 0.0722 * (pixel[2] ?? 0),
      ))
    }
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
  const textures: WebGLTexture[] = []
  const anisotropic = gl.getExtension('EXT_texture_filter_anisotropic')
  const maxAnisotropy = anisotropic
    ? Math.min(
        4,
        gl.getParameter(anisotropic.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number,
      )
    : 0

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
  const sceneTexture = texture(0, highMap)
  texture(1, highMap)
  texture(2, lowMap)
  highMap
    .getContext('webgl2')
    ?.getExtension('WEBGL_lose_context')
    ?.loseContext()
  lowMap
    .getContext('webgl2')
    ?.getExtension('WEBGL_lose_context')
    ?.loseContext()
  gl.uniform1i(gl.getUniformLocation(program, 'uScene'), 0)
  gl.uniform1i(gl.getUniformLocation(program, 'uHigh'), 1)
  gl.uniform1i(gl.getUniformLocation(program, 'uLow'), 2)
  let sceneGeneration = 0

  const uploadScene = (
    unit: number,
    target: WebGLTexture,
    image: TexImageSource,
  ) => {
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, target)
    // Decode sRGB before mipmap/anisotropic filtering; COMPOSITOR_SHADER
    // encodes the resulting linear color for the canvas again.
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.SRGB8_ALPHA8,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      image,
    )
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    if (anisotropic && maxAnisotropy > 1) {
      gl.texParameterf(
        gl.TEXTURE_2D,
        anisotropic.TEXTURE_MAX_ANISOTROPY_EXT,
        maxAnisotropy,
      )
    }
    gl.generateMipmap(gl.TEXTURE_2D)
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
      canvas.dataset.captureEngine = image instanceof HTMLCanvasElement
        ? (image.dataset.captureEngine ?? '')
        : ''
      canvas.dataset.captureScale = image instanceof HTMLCanvasElement
        ? (image.dataset.captureScale ?? '')
        : ''
      canvas.dataset.captureWidth = image instanceof HTMLCanvasElement
        ? String(image.width)
        : ''
      canvas.dataset.captureHeight = image instanceof HTMLCanvasElement
        ? String(image.height)
        : ''
      canvas.dataset.sceneSampling = maxAnisotropy > 1
        ? 'radial-gradient-anisotropic'
        : 'radial-gradient-trilinear'
      canvas.dataset.sceneAnisotropy = String(maxAnisotropy)
      canvas.dataset.excludedPetElements = image instanceof HTMLCanvasElement
        ? (image.dataset.excludedPetElements ?? '')
        : ''
      canvas.dataset.remainingPetElements = image instanceof HTMLCanvasElement
        ? (image.dataset.remainingPetElements ?? '')
        : ''
      canvas.dataset.visibleFileIcons = image instanceof HTMLCanvasElement
        ? (image.dataset.visibleFileIcons ?? '')
        : ''
      canvas.dataset.rasterizedFileIcons = image instanceof HTMLCanvasElement
        ? (image.dataset.rasterizedFileIcons ?? '')
        : ''
      canvas.dataset.cornerLuminance = image instanceof HTMLCanvasElement
        ? (image.dataset.cornerLuminance ?? '')
        : ''
      canvas.dataset.clonedBodyBackground = image instanceof HTMLCanvasElement
        ? (image.dataset.clonedBodyBackground ?? '')
        : ''
      canvas.style.opacity = '1'
    },
    draw(pose) {
      if (!canvas.width || !canvas.height) return
      const pixelRatio = canvas.width / window.innerWidth
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

const CYCLE_STATES: readonly DiskLook[] = [
  {
    phase: 'zen',
    temperature: 7000, inclination: 1.45, roll: 0.15,
    innerRadius: 3.5, outerRadius: 7, diskOpacity: 0.4,
    doppler: 0.5, beam: 2, gain: 0.5, contrast: 0.3,
    wind: 3, speed: 1.5, exposure: 0.7, starField: 0,
    size: 0.90, motion: 0.16, lens: 0.86, diskRate: 0.42,
  },
  {
    phase: 'm87',
    temperature: 3800, inclination: 0.55, roll: -0.30,
    innerRadius: 2.2, outerRadius: 6, diskOpacity: 0.45,
    doppler: 0.9, beam: 3.5, gain: 1.6, contrast: 0.4,
    wind: 3, speed: 2.5, exposure: 1.1, starField: 0,
    size: 0.93, motion: 0.24, lens: 0.92, diskRate: 0.58,
  },
  {
    phase: 'ember',
    temperature: 6500, inclination: 0.30, roll: 0,
    innerRadius: 3, outerRadius: 10, diskOpacity: 0.5,
    doppler: 0.8, beam: 2.5, gain: 1, contrast: 1.1,
    wind: 7, speed: 5, exposure: 1, starField: 0,
    size: 0.96, motion: 0.38, lens: 0.90, diskRate: 0.82,
  },
  {
    phase: 'gargantua',
    temperature: 4500, inclination: 1.52, roll: 0.10,
    innerRadius: 2.2, outerRadius: 7, diskOpacity: 0.85,
    doppler: 0.35, beam: 2, gain: 1.4, contrast: 0.5,
    wind: 7, speed: 5, exposure: 1.2, starField: 0,
    size: 0.98, motion: 0.44, lens: 0.93, diskRate: 0.88,
  },
  {
    phase: 'inferno',
    temperature: 5500, inclination: 1.50, roll: 0.35,
    innerRadius: 1.8, outerRadius: 8, diskOpacity: 0.9,
    doppler: 0.6, beam: 2.5, gain: 2.2, contrast: 1.6,
    wind: 7, speed: 5, exposure: 1.4, starField: 0,
    size: 1, motion: 0.72, lens: 1, diskRate: 1.20,
  },
  {
    phase: 'quasar',
    temperature: 15000, inclination: 1.30, roll: 0.35,
    innerRadius: 3, outerRadius: 9, diskOpacity: 0.35,
    doppler: 1, beam: 4, gain: 1.2, contrast: 1.3,
    wind: 8, speed: 5, exposure: 0.8, starField: 0,
    size: 0.98, motion: 0.78, lens: 1, diskRate: 1.30,
  },
  {
    phase: 'blazar',
    temperature: 18000, inclination: 1.05, roll: 0.55,
    innerRadius: 3, outerRadius: 10, diskOpacity: 0.3,
    doppler: 1, beam: 5, gain: 1, contrast: 1.5,
    wind: 9, speed: 6, exposure: 0.75, starField: 0,
    size: 0.96, motion: 0.84, lens: 1, diskRate: 1.38,
  },
  {
    phase: 'cooling',
    temperature: 5500, inclination: 1.50, roll: 0.35,
    innerRadius: 1.8, outerRadius: 8, diskOpacity: 0.9,
    doppler: 0.6, beam: 2.5, gain: 2.2, contrast: 1.6,
    wind: 7, speed: 5, exposure: 1.4, starField: 0,
    size: 0.94, motion: 0.32, lens: 0.90, diskRate: 0.68,
  },
] as const

function interpolateLook(
  first: DiskLook,
  second: DiskLook,
  amount: number,
  phase: string,
): DiskLook {
  return {
    phase,
    temperature: mix(first.temperature, second.temperature, amount),
    inclination: mix(first.inclination, second.inclination, amount),
    roll: mix(first.roll, second.roll, amount),
    innerRadius: mix(first.innerRadius, second.innerRadius, amount),
    outerRadius: mix(first.outerRadius, second.outerRadius, amount),
    diskOpacity: mix(first.diskOpacity, second.diskOpacity, amount),
    doppler: mix(first.doppler, second.doppler, amount),
    beam: mix(first.beam, second.beam, amount),
    gain: mix(first.gain, second.gain, amount),
    contrast: mix(first.contrast, second.contrast, amount),
    wind: mix(first.wind, second.wind, amount),
    speed: mix(first.speed, second.speed, amount),
    exposure: mix(first.exposure, second.exposure, amount),
    starField: mix(first.starField, second.starField, amount),
    size: mix(first.size, second.size, amount),
    motion: mix(first.motion, second.motion, amount),
    lens: mix(first.lens, second.lens, amount),
    diskRate: mix(first.diskRate, second.diskRate, amount),
  }
}

function createEvolutionCycle(seed: number, cycleIndex: number) {
  const zen = CYCLE_STATES[0]!
  const m87 = CYCLE_STATES[1]!
  const ember = CYCLE_STATES[2]!
  const gargantua = CYCLE_STATES[3]!
  const inferno = CYCLE_STATES[4]!
  const quasar = CYCLE_STATES[5]!
  const blazar = CYCLE_STATES[6]!
  const cooling = CYCLE_STATES[7]!
  const lowEnergy = seedValue(seed, cycleIndex, 20) >= 0
    ? [zen, m87]
    : [m87, zen]
  const warmDisk = seedValue(seed, cycleIndex, 21) >= 0
    ? [ember, gargantua]
    : [gargantua, ember]
  const highEnergy = seedValue(seed, cycleIndex, 22) >= 0
    ? [quasar, blazar]
    : [blazar, quasar]
  return [...lowEnergy, ...warmDisk, inferno, ...highEnergy, cooling] as const
}

function macroAt(
  elapsed: number,
  birth: DiskLook,
  evolutionSeed: number,
): DiskLook {
  const firstCycle = createEvolutionCycle(evolutionSeed, 0)
  const intro = clamp(elapsed / INTRO_SECONDS, 0, 1)
  if (intro < 1) {
    const amount = smoother(intro)
    const target = firstCycle[0]
    return interpolateLook(birth, target, amount, 'birth')
  }

  const cycleTime = elapsed - INTRO_SECONDS
  const cycleIndex = Math.floor(cycleTime / MIDDLE_CYCLE_SECONDS)
  const progress = (
    cycleTime - cycleIndex * MIDDLE_CYCLE_SECONDS
  ) / MIDDLE_CYCLE_SECONDS
  const cycle = cycleIndex === 0
    ? firstCycle
    : createEvolutionCycle(evolutionSeed, cycleIndex)
  const nextCycle = createEvolutionCycle(evolutionSeed, cycleIndex + 1)
  const slot = progress * cycle.length
  const slotIndex = Math.floor(slot)
  const first = cycle[slotIndex]!
  const second = slotIndex === cycle.length - 1
    ? nextCycle[0]
    : cycle[slotIndex + 1]!
  const amount = smoother(slot - slotIndex)
  const theta = progress * Math.PI * 2
  const wave =
    0.70 * Math.sin(theta) ** 3
    + 0.30 * Math.sin(theta * 2) ** 3
  const secondWave =
    0.65 * Math.sin(theta) ** 3
    + 0.35 * Math.sin(theta * 2) ** 3
  const result = interpolateLook(
    first,
    second,
    amount,
    amount < 0.5 ? first.phase : second.phase,
  )
  result.size = Math.min(1, result.size * (1 + secondWave * 0.010))
  result.motion = clamp(result.motion + secondWave * 0.025, 0, 1)
  result.lens = clamp(result.lens + wave * 0.012, 0, 1)
  result.diskRate *= 1 + secondWave * 0.025
  return result
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
  const evaporation = clamp((progress - 0.16) / 0.76, 0, 1)
  const remainingBody = Math.max(0, 1 - smoother(progress))
  return {
    progress,
    mass: Math.max(0.035, (1 - evaporation) ** (1 / 3)),
    diskFeed: Math.sqrt(Math.max(0, 1 - smoother(progress / 0.94))),
    hawking: smoother((progress - 0.12) / 0.78),
    burst: clamp((progress - 0.90) / 0.10, 0, 1),
    body: remainingBody ** 0.35,
    lens: remainingBody,
  }
}

function activePose(
  elapsed: number,
  look: DiskLook,
  seed: number,
  homeElement: () => Element | null,
  homeAttraction: number,
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
    centerX: mix(mix(homeUv.x, roam.x, departure), homeUv.x, homeAttraction) * width,
    centerY: mix(mix(homeUv.y, roam.y, departure), homeUv.y, homeAttraction) * height,
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
  onReady,
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
      setRestUntil() {},
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
  let restUntil = Number.POSITIVE_INFINITY
  let exitComplete: (() => void) | null = null
  let requestId = 0
  let lastClockAt = 0
  let diskClock = 18.5
  let initialSceneInFlight = false
  let initialSceneRetryId: number | null = null
  let initialSceneFailures = 0
  const testWindow = window as Window & {
    __FARMING_E2E__?: boolean
    __farmingBlackHoleElapsedSeconds?: number
    __farmingBlackHoleEvolutionSeed?: number
  }
  const startedAt = performance.now()
  const roamSeed = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0
  const requestedEvolutionSeed = testWindow.__farmingBlackHoleEvolutionSeed
  const evolutionSeed = testWindow.__FARMING_E2E__
    && Number.isInteger(requestedEvolutionSeed)
    ? Math.trunc(requestedEvolutionSeed!) >>> 0
    : roamSeed
  const firstCycle = createEvolutionCycle(evolutionSeed, 0)
  const birthTarget = firstCycle[0]
  const birthVariation = seedValue(roamSeed, 0, 12)
  const birth: DiskLook = {
    ...birthTarget,
    phase: 'birth',
    size: 0.72 + birthVariation * 0.04,
    motion: 0.06,
    lens: birthTarget.lens * (0.69 + birthVariation * 0.07),
    diskRate: birthTarget.diskRate * (0.55 + birthVariation * 0.07),
  }
  canvas.dataset.introSeconds = String(INTRO_SECONDS)
  canvas.dataset.cycleSeconds = String(MIDDLE_CYCLE_SECONDS)
  canvas.dataset.cycleOrder = firstCycle.map(state => state.phase).join(',')
  canvas.dataset.nextCycleOrder = createEvolutionCycle(evolutionSeed, 1)
    .map(state => state.phase)
    .join(',')
  canvas.dataset.birthPreset = birthTarget.phase

  const clearSchedule = () => {
    if (requestId) cancelAnimationFrame(requestId)
    requestId = 0
  }

  const completeExit = () => {
    clearSchedule()
    const complete = exitComplete
    exitComplete = null
    complete?.()
  }

  const schedule = () => {
    if (
      destroyed
      || !active
      || document.hidden
      || requestId
    ) return
    requestId = requestAnimationFrame(frame)
  }

  const clearInitialSceneRetry = () => {
    if (initialSceneRetryId === null) return
    window.clearTimeout(initialSceneRetryId)
    initialSceneRetryId = null
  }

  const loadInitialScene = () => {
    if (
      destroyed
      || sceneReady
      || initialSceneInFlight
      || !active
      || document.hidden
    ) return
    clearInitialSceneRetry()
    initialSceneInFlight = true
    compositorCanvas.dataset.refreshState = 'initial-capturing'
    void createSceneImage()
      .then(image => {
        if (destroyed) return
        compositor.setScene(image)
        sceneReady = true
        initialSceneFailures = 0
        compositorCanvas.dataset.refreshState = 'idle'
        delete compositorCanvas.dataset.refreshError
        onReady()
        schedule()
      })
      .catch(error => {
        if (destroyed) return
        initialSceneFailures += 1
        const message = error instanceof Error ? error.message : String(error)
        compositorCanvas.dataset.refreshState = 'initial-retry-wait'
        compositorCanvas.dataset.refreshError = message
        onError(message)
        const retryDelay = Math.min(
          INITIAL_SCENE_RETRY_MAX_MS,
          INITIAL_SCENE_RETRY_MIN_MS * 2 ** Math.min(initialSceneFailures - 1, 4),
        )
        initialSceneRetryId = window.setTimeout(() => {
          initialSceneRetryId = null
          loadInitialScene()
        }, retryDelay)
      })
      .finally(() => {
        initialSceneInFlight = false
      })
  }

  const applyPose = (pose: Pose) => {
    const pixelRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1))
    const snap = (value: number) => Math.round(value * pixelRatio) / pixelRatio
    display.resize(DISPLAY_SIZE * pose.scale)
    const size = display.canvasCssSize()
    canvas.style.transform =
      `translate3d(${snap(pose.centerX - size / 2)}px, ${snap(pose.centerY - size / 2)}px, 0)`
    canvas.style.opacity = String(pose.bodyOpacity)
  }

  function frame(now: number) {
    requestId = 0
    if (destroyed || !active || document.hidden) return
    const testElapsed = testWindow.__FARMING_E2E__
      ? testWindow.__farmingBlackHoleElapsedSeconds
      : undefined
    const elapsed = Number.isFinite(testElapsed)
      ? Number(testElapsed)
      : (now - startedAt) / 1000
    const look = macroAt(elapsed, birth, evolutionSeed)
    canvas.dataset.macroPhase = look.phase
    canvas.dataset.macroSize = look.size.toFixed(4)
    canvas.dataset.macroTemperature = look.temperature.toFixed(1)
    canvas.dataset.macroInclination = look.inclination.toFixed(4)
    canvas.dataset.macroOuterRadius = look.outerRadius.toFixed(3)
    const homeAttraction = smoother(clamp(
      1 - (restUntil - Date.now())
        / (BLACK_HOLE_HOME_ATTRACTION_SECONDS * 1000),
      0,
      1,
    ))
    canvas.dataset.homeAttraction = homeAttraction.toFixed(4)
    let evaporation = evaporationAt(0)
    let pose = activePose(
      elapsed,
      look,
      roamSeed,
      homeElement,
      homeAttraction,
    )

    if (exitingAt !== null) {
      const progress = clamp((now - exitingAt) / (exitDuration * 1000), 0, 1)
      compositorCanvas.dataset.exitProgress = progress.toFixed(4)
      evaporation = evaporationAt(progress)
      compositorCanvas.dataset.evaporationPhase = progress < 0.20
        ? 'disk-quench'
        : progress < 0.82
          ? 'blue-shift'
          : progress < 0.90
            ? 'photon-collapse'
            : 'final-release'
      compositorCanvas.dataset.hawking = evaporation.hawking.toFixed(4)
      compositorCanvas.dataset.finalBurst = evaporation.burst.toFixed(4)
      compositorCanvas.dataset.diskFeed = evaporation.diskFeed.toFixed(4)
      compositorCanvas.dataset.bodyOpacity = evaporation.body.toFixed(4)
      compositorCanvas.dataset.lensOpacity = evaporation.lens.toFixed(4)
      const exitElapsed = (exitingAt - startedAt) / 1000
      const frozenTime =
        exitElapsed + 0.45 * (1 - Math.exp(-(now - exitingAt) / 450))
      const frozenLook = macroAt(frozenTime, birth, evolutionSeed)
      pose = activePose(
        frozenTime,
        frozenLook,
        roamSeed,
        homeElement,
        homeAttraction,
      )
      const home = homePoint(homeElement)
      const returning = exitReturnsHome
        ? smoother(progress)
        : 0
      compositorCanvas.dataset.returnProgress = returning.toFixed(4)
      pose = {
        ...pose,
        centerX: mix(pose.centerX, home.x, returning),
        centerY: mix(pose.centerY, home.y, returning),
        mass: evaporation.mass,
        bodyOpacity: evaporation.body,
        lensOpacity: evaporation.lens * frozenLook.lens,
      }
      if (progress >= 1) {
        completeExit()
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
    if (sceneReady) compositor.draw(pose)
    display.draw(diskClock, pose.bodyOpacity, look, evaporation)
    schedule()
  }

  loadInitialScene()

  const onVisibilityChange = () => {
    if (document.hidden) {
      clearSchedule()
      lastClockAt = 0
    } else if (active) {
      loadInitialScene()
      schedule()
    }
  }
  document.addEventListener('visibilitychange', onVisibilityChange)

  return {
    setActive(nextActive) {
      active = nextActive
      if (!active) {
        clearSchedule()
        lastClockAt = 0
      } else {
        loadInitialScene()
        schedule()
      }
    },
    setRestUntil(nextRestUntil) {
      restUntil = nextRestUntil
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
      clearInitialSceneRetry()
      document.removeEventListener('visibilitychange', onVisibilityChange)
      compositorCanvas.style.opacity = '0'
      compositor.destroy()
      display.destroy()
    },
  }
}
