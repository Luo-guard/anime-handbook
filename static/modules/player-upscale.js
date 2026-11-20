import { S, M } from "./anime4k-shaders.js";

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

// Adapt the two bundled mpv shaders. Their feature maps stay at source
// resolution, and the final pass rearranges their channels into a 2× image.
function shaderPasses(source) {
  return source.split(/^\/\/!DESC /m).slice(1).map((pass) => ({
    inputs: [...pass.matchAll(/^\/\/!BIND (\w+)/gm)].map((match) => match[1]),
    output: pass.match(/^\/\/!SAVE (\w+)/m)[1],
    code: pass.split("\n").slice(1).filter((line) => !line.startsWith("//!")).join("\n"),
  }));
}

function createRenderer(canvas, mode) {
  const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, powerPreference: "high-performance" });
  if (!gl || !gl.getExtension("EXT_color_buffer_float")) throw new Error("WebGL 2 浮点渲染不可用");
  const maxSize = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), 4096);
  const programs = [];
  const textures = new Map();
  const framebuffer = gl.createFramebuffer();
  let width = 0;
  let height = 0;

  function dispose() {
    for (const { program } of programs) gl.deleteProgram(program);
    for (const texture of textures.values()) gl.deleteTexture(texture);
    gl.deleteFramebuffer(framebuffer);
  }

  try {
    const vertex = compile(gl, gl.VERTEX_SHADER, vertexSource);
    try {
      for (const pass of shaderPasses(mode === "quality" ? M : S)) {
        const bindings = pass.inputs.map((name) => `
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
        const samplers = pass.inputs.map((name) => gl.getUniformLocation(program, `${name}_sampler`));
        programs.push({ ...pass, program, samplers });
      }
    } finally {
      gl.deleteShader(vertex);
    }
    for (const name of new Set(["MAIN", ...programs.map((pass) => pass.output)])) {
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      const filter = name === "MAIN" ? gl.LINEAR : gl.NEAREST;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      textures.set(name, texture);
    }
  } catch (error) {
    dispose();
    throw error;
  }

  function draw(video) {
    const resized = width !== video.videoWidth || height !== video.videoHeight;
    if (resized) {
      width = video.videoWidth;
      height = video.videoHeight;
      if (width * 2 > maxSize || height * 2 > maxSize || width * height > 2048 * 1152) {
        throw new Error("片源分辨率超过内置超分的处理上限");
      }
      canvas.width = width * 2;
      canvas.height = height * 2;
      for (const [name, texture] of textures) {
        if (name === "MAIN") continue;
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
      }
    }

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, textures.get("MAIN"));
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    if (resized) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, video);
    for (const { output, inputs, program, samplers } of programs) {
      const last = output === "MAIN";
      gl.bindFramebuffer(gl.FRAMEBUFFER, last ? null : framebuffer);
      if (!last) {
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, textures.get(output), 0);
        if (resized && gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
          throw new Error("无法分配超分画布");
        }
      }
      gl.viewport(0, 0, last ? canvas.width : width, last ? canvas.height : height);
      gl.useProgram(program);
      inputs.forEach((name, index) => {
        gl.activeTexture(gl.TEXTURE0 + index);
        gl.bindTexture(gl.TEXTURE_2D, textures.get(name));
        gl.uniform1i(samplers[index], index);
      });
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    if (resized && gl.getError() !== gl.NO_ERROR) throw new Error("显卡无法处理当前画面");
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
