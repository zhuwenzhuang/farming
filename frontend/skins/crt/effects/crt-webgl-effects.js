(function attachCrtWebglEffects(global) {
  const HISTORY_SCALE = 0.5;
  const BLOOM_SCALE = 0.5;
  const EFFECT_FRAME_INTERVAL_MS = 50;
  const PHOSPHOR_FADE_MS = 1600;
  const SEQUENTIAL_INPUT_WINDOW_MS = 320;
  const RESIZE_SETTLE_MS = 300;

  const VERTEX_SHADER = `#version 300 es
    layout(location = 0) in vec2 a_position;
    out vec2 v_uv;

    void main() {
      v_uv = a_position * 0.5 + 0.5;
      gl_Position = vec4(a_position, 0.0, 1.0);
    }
  `;

  const FEEDBACK_SHADER = `#version 300 es
    precision mediump float;

    in vec2 v_uv;
    out vec4 out_color;

    uniform sampler2D u_current;
    uniform sampler2D u_history;
    uniform float u_decay;
    uniform float u_cursorSweep;
    uniform vec2 u_cursorFrom;
    uniform vec2 u_cursorTo;
    uniform vec2 u_grid;

    float luminance(vec3 color) {
      return dot(color, vec3(0.2126, 0.7152, 0.0722));
    }

    void main() {
      vec3 current = texture(u_current, v_uv).rgb;
      vec4 previous = texture(u_history, v_uv);
      float feedbackDecay = max(0.0, u_decay - previous.a);
      vec3 decayed = max(previous.rgb - vec3(feedbackDecay), vec3(0.0));
      vec2 cell = vec2(floor(v_uv.x * u_grid.x), floor((1.0 - v_uv.y) * u_grid.y));
      float sameRow = 1.0 - step(0.5, abs(u_cursorFrom.y - u_cursorTo.y));
      float onRow = 1.0 - step(0.5, abs(cell.y - u_cursorTo.y));
      float withinColumns = step(min(u_cursorFrom.x, u_cursorTo.x), cell.x)
        * step(cell.x, max(u_cursorFrom.x, u_cursorTo.x));
      float cursorTrail = u_cursorSweep * sameRow * onRow * withinColumns;
      vec3 cursorPhosphor = vec3(0.0, 1.0, 0.255) * cursorTrail * 0.78;
      vec3 accumulated = max(max(decayed, current), cursorPhosphor);
      float currentMask = step(luminance(accumulated), luminance(current) + 0.0005);
      currentMask *= 1.0 - step(0.001, cursorTrail);
      out_color = vec4(accumulated, currentMask);
    }
  `;

  const BLOOM_SHADER = `#version 300 es
    precision mediump float;

    in vec2 v_uv;
    out vec4 out_color;

    uniform sampler2D u_current;
    uniform vec2 u_texel;

    void main() {
      vec3 color = texture(u_current, v_uv).rgb * 0.22;
      color += texture(u_current, v_uv + vec2(u_texel.x, 0.0)).rgb * 0.13;
      color += texture(u_current, v_uv - vec2(u_texel.x, 0.0)).rgb * 0.13;
      color += texture(u_current, v_uv + vec2(0.0, u_texel.y)).rgb * 0.13;
      color += texture(u_current, v_uv - vec2(0.0, u_texel.y)).rgb * 0.13;
      color += texture(u_current, v_uv + u_texel * vec2(1.5, 1.5)).rgb * 0.065;
      color += texture(u_current, v_uv + u_texel * vec2(-1.5, 1.5)).rgb * 0.065;
      color += texture(u_current, v_uv + u_texel * vec2(1.5, -1.5)).rgb * 0.065;
      color += texture(u_current, v_uv + u_texel * vec2(-1.5, -1.5)).rgb * 0.065;
      out_color = vec4(color, 1.0);
    }
  `;

  const COMPOSITE_SHADER = `#version 300 es
    precision mediump float;

    in vec2 v_uv;
    out vec4 out_color;

    uniform sampler2D u_current;
    uniform sampler2D u_history;
    uniform sampler2D u_bloom;
    uniform sampler2D u_noise;
    uniform vec2 u_resolution;
    uniform float u_time;
    uniform float u_historyAge;

    float luminance(vec3 color) {
      return dot(color, vec3(0.2126, 0.7152, 0.0722));
    }

    void main() {
      vec2 noiseUv = fract(v_uv * vec2(4.0, 3.0) + vec2(u_time * 0.071, u_time * 0.043));
      vec4 noise = texture(u_noise, noiseUv);

      vec2 jitterPixels = (noise.rg - vec2(0.5)) * vec2(0.42, 0.16);
      float syncNoise = texture(u_noise, vec2(fract(u_time * 0.017), fract(v_uv.y * 3.0 + u_time * 0.011))).r;
      float syncGate = smoothstep(0.988, 1.0, syncNoise);
      jitterPixels.x += sin((v_uv.y * 18.0 + u_time * 0.7) * 6.2831853) * syncGate * 0.55;

      vec2 jitteredUv = clamp(v_uv + jitterPixels / u_resolution, vec2(0.0), vec2(1.0));
      vec3 current = texture(u_current, jitteredUv).rgb;
      vec4 historySample = texture(u_history, v_uv);
      vec3 bloom = texture(u_bloom, jitteredUv).rgb;

      float fade = clamp(u_historyAge, 0.0, 1.0);
      vec3 history = max(historySample.rgb - vec3(fade), vec3(0.0));
      // xterm's WebGL canvas contains opaque panel/background colors as well as
      // emissive glyphs. Keep dim UI surfaces out of the visible persistence
      // layer and give bright phosphor a restrained initial response; the long
      // fade below supplies the perceptible tail without obscuring scrolling.
      float phosphorResponse = smoothstep(0.24, 0.92, luminance(historySample.rgb));
      float burnInStrength = mix(0.006, 0.075, phosphorResponse);
      vec3 ghost = history * (1.0 - historySample.a) * burnInStrength;

      float scanPosition = fract(u_time / 6.7);
      float scanDistance = v_uv.y - scanPosition;
      float scanTrail = smoothstep(0.30, 0.0, scanDistance) * step(0.0, scanDistance);
      float scanFront = exp(-abs(scanDistance) * 90.0);

      float staticNoise = (noise.b - 0.5) * 0.018;
      float flickerNoise = texture(u_noise, vec2(fract(u_time * 0.037), 0.173)).a - 0.5;
      float flicker = 1.0 + flickerNoise * 0.026;

      float glowStrength = clamp(luminance(current) * 0.13 + luminance(bloom) * 0.22, 0.0, 0.22);
      vec3 glow = bloom * 0.11 + current * 0.025;
      vec3 signal = ghost + glow;
      signal += vec3(0.015, 0.085, 0.038) * max(0.0, staticNoise + scanTrail * 0.055 + scanFront * 0.05);
      signal *= flicker;

      float alpha = clamp(max(signal.r, max(signal.g, signal.b)), 0.0, 0.58);
      vec3 straightColor = alpha > 0.0001 ? clamp(signal / alpha, 0.0, 1.0) : vec3(0.0);
      out_color = vec4(straightColor, alpha);
    }
  `;

  function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader) || 'Unknown shader compilation error';
      gl.deleteShader(shader);
      throw new Error(message);
    }
    return shader;
  }

  function createProgram(gl, fragmentSource) {
    const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    const program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const message = gl.getProgramInfoLog(program) || 'Unknown shader link error';
      gl.deleteProgram(program);
      throw new Error(message);
    }
    return program;
  }

  function createTexture(gl, width, height, data = null) {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    return texture;
  }

  function createFramebuffer(gl, texture) {
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteFramebuffer(framebuffer);
      throw new Error('CRT WebGL framebuffer is incomplete.');
    }
    return framebuffer;
  }

  function createNoiseData(size) {
    const data = new Uint8Array(size * size * 4);
    let seed = 0x43525432;
    for (let index = 0; index < data.length; index += 1) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      data[index] = seed >>> 24;
    }
    return data;
  }

  function scaledSize(value, scale) {
    return Math.max(1, Math.round(value * scale));
  }

  class CrtWebglEffects {
    constructor(options) {
      this.terminal = options.terminal;
      this.container = options.container;
      this.onError = options.onError || (() => {});
      this.canvas = global.document.createElement('canvas');
      this.canvas.className = 'crt-webgl-effects-canvas';
      this.canvas.setAttribute('aria-hidden', 'true');
      this.gl = this.canvas.getContext('webgl2', {
        alpha: true,
        antialias: false,
        depth: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
        stencil: false,
      });
      if (!this.gl) {
        throw new Error('Farming CRT effects require WebGL2 hardware acceleration.');
      }

      this.sourceCanvas = null;
      this.sourceDirty = true;
      this.lastCaptureAt = 0;
      this.lastEffectFrameAt = 0;
      this.lastSourceWidth = 0;
      this.lastSourceHeight = 0;
      this.lastCursorPosition = null;
      this.sequentialInputUntil = 0;
      this.resizePendingUntil = 0;
      this.frameRequest = 0;
      this.effectTimer = 0;
      this.disposed = false;
      this.resources = null;
      this.enabled = !global.document.body.classList.contains('no-crt');
      this.canvas.style.display = this.enabled ? '' : 'none';

      this.programs = {
        feedback: createProgram(this.gl, FEEDBACK_SHADER),
        bloom: createProgram(this.gl, BLOOM_SHADER),
        composite: createProgram(this.gl, COMPOSITE_SHADER),
      };
      this.setupGeometry();
      this.setupNoiseTexture();
      this.bindLifecycle();
      this.container.appendChild(this.canvas);
      this.scheduleEffectFrame(0);
    }

    setupGeometry() {
      const gl = this.gl;
      this.vertexArray = gl.createVertexArray();
      this.positionBuffer = gl.createBuffer();
      gl.bindVertexArray(this.vertexArray);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        -1, -1,
        1, -1,
        -1, 1,
        1, 1,
      ]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
    }

    setupNoiseTexture() {
      const gl = this.gl;
      const size = 128;
      this.noiseTexture = createTexture(gl, size, size, createNoiseData(size));
      gl.bindTexture(gl.TEXTURE_2D, this.noiseTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    }

    bindLifecycle() {
      this.renderDisposable = this.terminal.onRender
        ? this.terminal.onRender(() => this.markSourceDirty())
        : null;
      this.inputDisposable = this.terminal.onData
        ? this.terminal.onData((data) => this.observeTerminalInput(data))
        : null;
      this.visibilityListener = () => {
        if (!global.document.hidden) {
          this.markSourceDirty();
          this.scheduleEffectFrame(0);
        }
      };
      global.document.addEventListener('visibilitychange', this.visibilityListener);
      this.classObserver = new MutationObserver(() => {
        const enabled = !global.document.body.classList.contains('no-crt');
        if (enabled !== this.enabled) {
          this.enabled = enabled;
          this.canvas.style.display = enabled ? '' : 'none';
          if (enabled) {
            this.markSourceDirty();
            this.scheduleEffectFrame(0);
          } else if (this.effectTimer) {
            global.clearTimeout(this.effectTimer);
            this.effectTimer = 0;
          }
        }
      });
      this.classObserver.observe(global.document.body, { attributes: true, attributeFilter: ['class'] });
      this.canvas.addEventListener('webglcontextlost', (event) => {
        event.preventDefault();
        this.fail(new Error('The CRT WebGL effects context was lost. Reload the terminal to restore it.'));
      });
    }

    findSourceCanvas() {
      const terminalElement = this.terminal.element;
      if (!terminalElement) return null;
      const candidates = Array.from(terminalElement.querySelectorAll('.xterm-screen canvas'))
        .filter((candidate) => (
          candidate !== this.canvas
          && !candidate.classList.contains('xterm-link-layer')
          && candidate.width > 0
          && candidate.height > 0
        ));
      return candidates.sort((left, right) => right.width * right.height - left.width * left.height)[0] || null;
    }

    markSourceDirty() {
      if (this.disposed) return;
      this.sourceDirty = true;
      this.requestFrame();
    }

    observeTerminalInput(data) {
      const now = global.performance && typeof global.performance.now === 'function'
        ? global.performance.now()
        : Date.now();
      const sequential = typeof data === 'string'
        && data.length > 0
        && !/[\x00-\x1f\x7f]/.test(data);
      this.sequentialInputUntil = sequential ? now + SEQUENTIAL_INPUT_WINDOW_MS : 0;
    }

    requestFrame() {
      if (this.frameRequest || this.disposed || global.document.hidden) return;
      this.frameRequest = global.requestAnimationFrame((timestamp) => {
        this.frameRequest = 0;
        this.draw(timestamp);
      });
    }

    scheduleEffectFrame(delay = EFFECT_FRAME_INTERVAL_MS) {
      if (this.effectTimer || this.disposed || global.document.hidden || !this.enabled) return;
      this.effectTimer = global.setTimeout(() => {
        this.effectTimer = 0;
        this.requestFrame();
        this.scheduleEffectFrame();
      }, delay);
    }

    ensureResources(now) {
      const source = this.findSourceCanvas();
      if (!source) return false;
      if (source !== this.sourceCanvas || source.width !== this.lastSourceWidth || source.height !== this.lastSourceHeight) {
        this.sourceCanvas = source;
        if (source.parentElement && this.canvas.parentElement !== source.parentElement) {
          source.parentElement.appendChild(this.canvas);
        }
        this.lastSourceWidth = source.width;
        this.lastSourceHeight = source.height;
        this.resizePendingUntil = now + RESIZE_SETTLE_MS;
        this.destroyRenderTargets();
        this.canvas.style.visibility = 'hidden';
        return false;
      }
      if (now < this.resizePendingUntil) return false;
      if (!this.resources) {
        this.createRenderTargets(source.width, source.height);
        this.sourceDirty = true;
        this.canvas.style.visibility = '';
      }
      return true;
    }

    createRenderTargets(width, height) {
      const gl = this.gl;
      const historyWidth = scaledSize(width, HISTORY_SCALE);
      const historyHeight = scaledSize(height, HISTORY_SCALE);
      const bloomWidth = scaledSize(width, BLOOM_SCALE);
      const bloomHeight = scaledSize(height, BLOOM_SCALE);
      const currentTexture = createTexture(gl, width, height);
      const historyTextures = [
        createTexture(gl, historyWidth, historyHeight),
        createTexture(gl, historyWidth, historyHeight),
      ];
      const historyFramebuffers = historyTextures.map((texture) => createFramebuffer(gl, texture));
      const bloomTexture = createTexture(gl, bloomWidth, bloomHeight);
      const bloomFramebuffer = createFramebuffer(gl, bloomTexture);

      this.canvas.width = width;
      this.canvas.height = height;
      this.resources = {
        width,
        height,
        historyWidth,
        historyHeight,
        bloomWidth,
        bloomHeight,
        currentTexture,
        historyTextures,
        historyFramebuffers,
        historyIndex: 0,
        bloomTexture,
        bloomFramebuffer,
      };
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, width, height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }

    destroyRenderTargets() {
      if (!this.resources) return;
      const gl = this.gl;
      gl.deleteTexture(this.resources.currentTexture);
      this.resources.historyTextures.forEach((texture) => gl.deleteTexture(texture));
      this.resources.historyFramebuffers.forEach((framebuffer) => gl.deleteFramebuffer(framebuffer));
      gl.deleteTexture(this.resources.bloomTexture);
      gl.deleteFramebuffer(this.resources.bloomFramebuffer);
      this.resources = null;
      this.lastCaptureAt = 0;
      this.lastCursorPosition = null;
    }

    bindTexture(program, name, texture, unit) {
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(gl.getUniformLocation(program, name), unit);
    }

    drawPass(program, framebuffer, width, height) {
      const gl = this.gl;
      gl.useProgram(program);
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.viewport(0, 0, width, height);
      gl.bindVertexArray(this.vertexArray);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    captureCurrent(now) {
      const gl = this.gl;
      const resources = this.resources;
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.bindTexture(gl.TEXTURE_2D, resources.currentTexture);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.sourceCanvas);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

      const previousIndex = resources.historyIndex;
      const nextIndex = previousIndex === 0 ? 1 : 0;
      const feedbackProgram = this.programs.feedback;
      gl.useProgram(feedbackProgram);
      this.bindTexture(feedbackProgram, 'u_current', resources.currentTexture, 0);
      this.bindTexture(feedbackProgram, 'u_history', resources.historyTextures[previousIndex], 1);
      const elapsed = this.lastCaptureAt ? Math.min(PHOSPHOR_FADE_MS, now - this.lastCaptureAt) : PHOSPHOR_FADE_MS;
      gl.uniform1f(gl.getUniformLocation(feedbackProgram, 'u_decay'), elapsed / PHOSPHOR_FADE_MS);
      const activeBuffer = this.terminal.buffer && this.terminal.buffer.active;
      const cursorPosition = activeBuffer
        ? { x: activeBuffer.cursorX, y: activeBuffer.cursorY }
        : null;
      const cursorDistance = cursorPosition && this.lastCursorPosition
        ? Math.abs(cursorPosition.x - this.lastCursorPosition.x)
        : 0;
      const shouldSweepCursor = Boolean(
        now < this.sequentialInputUntil
        && cursorPosition
        && this.lastCursorPosition
        && cursorPosition.y === this.lastCursorPosition.y
        && cursorDistance > 1
        && cursorDistance <= 64
      );
      const cursorFrom = this.lastCursorPosition || cursorPosition || { x: 0, y: 0 };
      const cursorTo = cursorPosition || cursorFrom;
      gl.uniform1f(gl.getUniformLocation(feedbackProgram, 'u_cursorSweep'), shouldSweepCursor ? 1 : 0);
      gl.uniform2f(gl.getUniformLocation(feedbackProgram, 'u_cursorFrom'), cursorFrom.x, cursorFrom.y);
      gl.uniform2f(gl.getUniformLocation(feedbackProgram, 'u_cursorTo'), cursorTo.x, cursorTo.y);
      gl.uniform2f(gl.getUniformLocation(feedbackProgram, 'u_grid'), this.terminal.cols, this.terminal.rows);
      this.drawPass(
        feedbackProgram,
        resources.historyFramebuffers[nextIndex],
        resources.historyWidth,
        resources.historyHeight
      );
      resources.historyIndex = nextIndex;
      this.lastCursorPosition = cursorPosition;

      const bloomProgram = this.programs.bloom;
      gl.useProgram(bloomProgram);
      this.bindTexture(bloomProgram, 'u_current', resources.currentTexture, 0);
      gl.uniform2f(
        gl.getUniformLocation(bloomProgram, 'u_texel'),
        2 / resources.width,
        2 / resources.height
      );
      this.drawPass(bloomProgram, resources.bloomFramebuffer, resources.bloomWidth, resources.bloomHeight);

      this.lastCaptureAt = now;
      this.sourceDirty = false;
    }

    composite(now) {
      const gl = this.gl;
      const resources = this.resources;
      const program = this.programs.composite;
      gl.useProgram(program);
      this.bindTexture(program, 'u_current', resources.currentTexture, 0);
      this.bindTexture(program, 'u_history', resources.historyTextures[resources.historyIndex], 1);
      this.bindTexture(program, 'u_bloom', resources.bloomTexture, 2);
      this.bindTexture(program, 'u_noise', this.noiseTexture, 3);
      gl.uniform2f(gl.getUniformLocation(program, 'u_resolution'), resources.width, resources.height);
      gl.uniform1f(gl.getUniformLocation(program, 'u_time'), now / 1000);
      const historyAge = this.lastCaptureAt ? Math.min(1, (now - this.lastCaptureAt) / PHOSPHOR_FADE_MS) : 1;
      gl.uniform1f(gl.getUniformLocation(program, 'u_historyAge'), historyAge);
      gl.clearColor(0, 0, 0, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, resources.width, resources.height);
      gl.clear(gl.COLOR_BUFFER_BIT);
      // The effects canvas is cleared before every composite pass, so write the
      // shader's straight RGBA output directly. Blending into transparent here
      // would multiply alpha once in WebGL and again in browser composition,
      // making the phosphor signal nearly invisible.
      this.drawPass(program, null, resources.width, resources.height);
    }

    draw(timestamp) {
      if (this.disposed || global.document.hidden || !this.enabled) return;
      try {
        if (!this.ensureResources(timestamp)) {
          this.scheduleEffectFrame(Math.max(16, this.resizePendingUntil - timestamp));
          return;
        }
        const captured = this.sourceDirty;
        if (captured) this.captureCurrent(timestamp);
        if (!this.lastCaptureAt) return;
        if (!this.lastEffectFrameAt || timestamp - this.lastEffectFrameAt >= EFFECT_FRAME_INTERVAL_MS - 2) {
          this.composite(timestamp);
          this.lastEffectFrameAt = timestamp;
        }
      } catch (error) {
        this.fail(error);
      }
    }

    fail(error) {
      if (this.disposed) return;
      this.canvas.style.display = 'none';
      this.onError(error instanceof Error ? error : new Error(String(error)));
      this.dispose();
    }

    dispose() {
      if (this.disposed) return;
      this.disposed = true;
      if (this.frameRequest) global.cancelAnimationFrame(this.frameRequest);
      if (this.effectTimer) global.clearTimeout(this.effectTimer);
      if (this.renderDisposable && this.renderDisposable.dispose) this.renderDisposable.dispose();
      if (this.inputDisposable && this.inputDisposable.dispose) this.inputDisposable.dispose();
      if (this.classObserver) this.classObserver.disconnect();
      global.document.removeEventListener('visibilitychange', this.visibilityListener);
      this.destroyRenderTargets();
      const gl = this.gl;
      Object.values(this.programs).forEach((program) => gl.deleteProgram(program));
      gl.deleteTexture(this.noiseTexture);
      gl.deleteBuffer(this.positionBuffer);
      gl.deleteVertexArray(this.vertexArray);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      this.canvas.remove();
    }
  }

  global.FarmingCrtWebglEffects = {
    HISTORY_SCALE,
    BLOOM_SCALE,
    EFFECT_FRAME_INTERVAL_MS,
    PHOSPHOR_FADE_MS,
    SEQUENTIAL_INPUT_WINDOW_MS,
    create(options) {
      return new CrtWebglEffects(options);
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
