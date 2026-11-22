import { LITE, QUALITY } from "./anime4k-shaders.js?v=2";

/*
 * 浏览器里的 Anime4K：把 Kazumi 的 mpv glsl-shaders 链逐 pass 翻成 WebGL2。
 *
 * Kazumi 用 mpv 的 hook 机制（MAIN / PREKERNEL / OUTPUT / NATIVE），这里用一张
 * 当前图像 + 若干中间纹理模拟同样的顺序：
 *   - MAIN 是当前图像，NATIVE 是未放大的原始帧，OUTPUT 是最终画布（源尺寸 ×2）
 *   - //!SAVE 决定这一 pass 写到哪个名字；同名再写就换一张纹理（ping-pong）
 *   - //!WHEN 用 mpv 的后缀表达式求值，所以 AutoDownscalePre 在 2× 输出下会像
 *     mpv 一样自动跳过，不会把已经放大的画面又缩回去
 * 着色器代码和权重与 Kazumi 完全一致，没有改一行。
 */

const vertexSource = `#version 300 es
out vec2 uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  const message = gl.getShaderInfoLog(shader);
  gl.deleteShader(shader);
  throw new Error(message);
}

function parsePasses(source) {
  return source.split(/^\/\/!DESC /m).slice(1).map((chunk) => {
    const lines = chunk.split("\n");
    const pass = { desc: lines[0].trim(), hook: "MAIN", binds: [], save: null, width: null, height: null, when: null };
    for (const line of lines) {
      const match = line.match(/^\/\/!(HOOK|BIND|SAVE|WIDTH|HEIGHT|COMPONENTS|WHEN)\s+(.+)$/);
      if (!match) continue;
      const value = match[2].trim();
      if (match[1] === "HOOK") pass.hook = value;
      else if (match[1] === "BIND") pass.binds.push(value);
      else if (match[1] === "SAVE") pass.save = value;
      else if (match[1] === "WIDTH") pass.width = value;
      else if (match[1] === "HEIGHT") pass.height = value;
      else if (match[1] === "WHEN") pass.when = value;
    }
    pass.code = lines.slice(1).filter((line) => !line.startsWith("//!")).join("\n");
    return pass;
  });
}

// mpv 的后缀表达式：数字、NAME.w / NAME.h、+ - * /、> <。
function evaluate(expression, sizeOf) {
  const stack = [];
  for (const token of expression.trim().split(/\s+/)) {
    if (/^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(token)) {
      stack.push(Number(token));
      continue;
    }
    const size = token.match(/^([A-Za-z_]\w*)\.([wh])$/);
    if (size) {
      stack.push(sizeOf(size[1], size[2]));
      continue;
    }
    const b = stack.pop();
    const a = stack.pop();
    switch (token) {
      case ">": stack.push(a > b ? 1 : 0); break;
      case "<": stack.push(a < b ? 1 : 0); break;
      case "*": stack.push(a * b); break;
      case "/": stack.push(a / b); break;
      case "+": stack.push(a + b); break;
      case "-": stack.push(a - b); break;
      default: throw new Error(`超分表达式无法解析：${token}`);
    }
  }
  return stack.pop();
}

function createRenderer(canvas, mode) {
  const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, powerPreference: "high-performance" });
  if (!gl || !gl.getExtension("EXT_color_buffer_float")) throw new Error("WebGL 2 浮点渲染不可用");
  const maxSize = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), 4096);
  const passes = parsePasses(mode === "quality" ? QUALITY : LITE);
  const programs = [];
  const blit = (() => {
    const program = gl.createProgram();
    const vertex = compile(gl, gl.VERTEX_SHADER, vertexSource);
    const fragment = compile(gl, gl.FRAGMENT_SHADER, `#version 300 es
precision highp float;
in vec2 uv;
out vec4 color;
uniform sampler2D source_sampler;
void main() { color = texture(source_sampler, uv); }`);
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    return { program, sampler: gl.getUniformLocation(program, "source_sampler") };
  })();
  const cache = new Map();
  const framebuffer = gl.createFramebuffer();
  let videoTexture = null;
  let width = 0;
  let height = 0;
  let outputWidth = 0;
  let outputHeight = 0;
  const debug = typeof window !== "undefined" && window.__SR_DEBUG;
  const check = (label) => {
    if (!debug) return;
    const code = gl.getError();
    if (code) throw new Error(`${label} 出错（GL ${code}）`);
  };

  function dispose() {
    for (const { program } of programs) gl.deleteProgram(program);
    gl.deleteProgram(blit.program);
    for (const entry of cache.values()) gl.deleteTexture(entry.texture);
    cache.clear();
    if (videoTexture) gl.deleteTexture(videoTexture);
    gl.deleteFramebuffer(framebuffer);
  }

  try {
    const vertex = compile(gl, gl.VERTEX_SHADER, vertexSource);
    try {
      for (const pass of passes) {
        const names = new Set([...pass.binds, pass.hook]);
        // 有些 pass 在代码里直接用了没写进 //!BIND 的纹理（比如 Restore 的 MAIN），
        // 从代码里补出来，和 mpv 的隐式绑定等价。
        for (const match of pass.code.matchAll(/\b([A-Za-z_]\w*?)_(tex|texOff|pos|size|pt)\b/g)) names.add(match[1]);
        names.delete("vec");
        const bindings = [...names].map((name) => `
uniform sampler2D ${name}_sampler;
#define ${name}_size vec2(textureSize(${name}_sampler, 0))
#define ${name}_pt (1.0 / ${name}_size)
#define ${name}_pos uv
#define ${name}_tex(p) texture(${name}_sampler, p)
#define ${name}_texOff(p) ${name}_tex(uv + (p) * ${name}_pt)
`).join("\n");
        const fragment = compile(gl, gl.FRAGMENT_SHADER, `#version 300 es
precision highp float;
in vec2 uv;
out vec4 color;
${bindings}
${pass.code}
void main() { color = hook(); }`);
        const program = gl.createProgram();
        gl.attachShader(program, vertex);
        gl.attachShader(program, fragment);
        gl.linkProgram(program);
        gl.deleteShader(fragment);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
          const message = gl.getProgramInfoLog(program);
          gl.deleteProgram(program);
          throw new Error(message);
        }
        const samplers = [...names].map((name) => gl.getUniformLocation(program, `${name}_sampler`));
        programs.push({ ...pass, program, names: [...names], samplers });
      }
    } finally {
      gl.deleteShader(vertex);
    }
  } catch (error) {
    dispose();
    throw error;
  }

  function clearTextures() {
    for (const entry of cache.values()) gl.deleteTexture(entry.texture);
    cache.clear();
  }

  function textureFor(name, w, h, slot) {
    const key = `${name}|${w}x${h}|${slot}`;
    let entry = cache.get(key);
    if (entry) return entry;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    // 中间特征图按 texel 精确取样，和 mpv 的 NEAREST 一致
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    entry = { texture, w, h };
    cache.set(key, entry);
    return entry;
  }

  function resize(nextWidth, nextHeight) {
    if (nextWidth === width && nextHeight === height) return;
    const nextOutputWidth = nextWidth * 2;
    const nextOutputHeight = nextHeight * 2;
    if (nextOutputWidth > maxSize || nextOutputHeight > maxSize || nextWidth * nextHeight > 2048 * 1152) {
      throw new Error("片源分辨率超过内置超分的处理上限");
    }
    width = nextWidth;
    height = nextHeight;
    outputWidth = nextOutputWidth;
    outputHeight = nextOutputHeight;
    canvas.width = outputWidth;
    canvas.height = outputHeight;
    clearTextures();
    if (videoTexture) gl.deleteTexture(videoTexture);
    videoTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, videoTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  }

  function draw(video) {
    resize(video.videoWidth, video.videoHeight);
    const native = { texture: videoTexture, w: width, h: height };
    const images = new Map([["MAIN", native], ["NATIVE", native], ["HOOKED", native]]);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, videoTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, video);
    check("上传视频帧");

    const produced = new Map();
    const sizeOf = (name, which) => {
      if (name === "OUTPUT") return which === "w" ? outputWidth : outputHeight;
      const image = images.get(name);
      if (!image) throw new Error(`超分表达式引用了未知纹理：${name}`);
      return which === "w" ? image.w : image.h;
    };

    for (const pass of programs) {
      if (pass.when && !evaluate(pass.when, sizeOf)) continue;
      const target = pass.save || (pass.hook === "PREKERNEL" ? "MAIN" : pass.hook);
      const hooked = images.get(pass.hook === "PREKERNEL" ? "MAIN" : pass.hook) || images.get("MAIN");
      const targetWidth = pass.width ? Math.round(evaluate(pass.width, sizeOf)) : hooked.w;
      const targetHeight = pass.height ? Math.round(evaluate(pass.height, sizeOf)) : hooked.h;
      // 同名纹理一帧内可能被写多次（Clamp 的 STATSMAX、Restore 的 MAIN），
      // 每次换一块，避免「读的正是要写的这张」造成反馈环。
      const count = produced.get(target) || 0;
      const slot = count % 2;
      produced.set(target, count + 1);
      const entry = textureFor(target, targetWidth, targetHeight, slot);
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, entry.texture, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error("无法分配超分画布");
      }
      gl.viewport(0, 0, targetWidth, targetHeight);
      gl.useProgram(pass.program);
      pass.names.forEach((name, index) => {
        const image = images.get(name) || images.get("MAIN");
        gl.activeTexture(gl.TEXTURE0 + index);
        gl.bindTexture(gl.TEXTURE_2D, image.texture);
        gl.uniform1i(pass.samplers[index], index);
      });
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      check(pass.desc);
      images.set(target, { texture: entry.texture, w: targetWidth, h: targetHeight });
      if (target === "MAIN") images.set("HOOKED", { texture: entry.texture, w: targetWidth, h: targetHeight });
    }
    // 链的最后一 pass 写在离屏纹理里，这里再贴到画布上（等价 mpv 的最终输出）。
    const result = images.get("MAIN");
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, outputWidth, outputHeight);
    gl.useProgram(blit.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, result.texture);
    gl.uniform1i(blit.sampler, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (gl.getError() !== gl.NO_ERROR) throw new Error("显卡无法处理当前画面");
  }

  return { draw, dispose };
}

export function startPlayerUpscale(video, surface, mode, onState) {
  if (!video.requestVideoFrameCallback) throw new Error("浏览器不支持视频帧回调");
  const canvas = document.createElement("canvas");
  canvas.className = "pc-native-upscale";
  canvas.hidden = true;
  canvas.setAttribute("aria-hidden", "true");
  const renderer = createRenderer(canvas, mode);
  const listeners = new AbortController();
  let frame;
  let stopped = false;
  surface.append(canvas);

  function stop() {
    if (stopped) return;
    stopped = true;
    listeners.abort();
    if (frame !== undefined) video.cancelVideoFrameCallback(frame);
    renderer.dispose();
    canvas.remove();
  }

  function fail(message) {
    stop();
    onState(message);
  }

  function draw() {
    if (stopped || video.readyState < 2 || video.seeking || !video.videoWidth) return false;
    try {
      renderer.draw(video);
      if (canvas.hidden) {
        canvas.hidden = false;
        onState("");
      }
      return true;
    } catch (error) {
      fail(error.name === "SecurityError" ? "片源不允许浏览器读取视频帧" : error.message);
      return false;
    }
  }

  function next() {
    frame = undefined;
    draw();
    if (!stopped) frame = video.requestVideoFrameCallback(next);
  }

  canvas.addEventListener("webglcontextlost", () => fail("显卡渲染已中断"), { signal: listeners.signal });
  video.addEventListener("seeked", draw, { signal: listeners.signal });
  video.addEventListener("resize", draw, { signal: listeners.signal });
  frame = video.requestVideoFrameCallback(next);
  draw();

  return {
    stop,
    capture() {
      if (!draw()) return null;
      const still = document.createElement("canvas");
      still.width = canvas.width;
      still.height = canvas.height;
      still.getContext("2d").drawImage(canvas, 0, 0);
      return still;
    },
  };
}
