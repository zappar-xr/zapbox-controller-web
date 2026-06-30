import { mat4, quat, vec3 } from 'gl-matrix';
import type { ControllerBinding } from './ZapboxSessionAdapter.js';
import { headingFromOrientation, recenterOffsetFromGaze } from './pose.js';
import { ZAPBOX_WORDMARK_SVG } from '../branding.js';

/** Wordmark aspect ratio (viewBox 166.79 × 46.52), used to size it on the prompt canvas. */
const WORDMARK_ASPECT = 166.79 / 46.52;

const DISTANCE = 1.5;       // metres in front of the viewer
const QUAD_W = 1.0;         // metres
const QUAD_H = 0.5;         // metres (2:1, matches the texture canvas aspect)

const VERT_SRC = `
attribute vec2 aPos;
attribute vec2 aUV;
uniform mat4 uMVP;
varying vec2 vUV;
void main() {
  vUV = aUV;
  gl_Position = uMVP * vec4(aPos, 0.0, 1.0);
}`;

const FRAG_SRC = `
precision mediump float;
varying vec2 vUV;
uniform sampler2D uTex;
void main() {
  gl_FragColor = texture2D(uTex, vUV);
}`;

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  return sh;
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Render the prompt to a 2D canvas → GL texture: a rounded dark panel, the Zapbox wordmark across
 * the top, and the instruction text below it. Wording depends on how many controllers are paired.
 * The wordmark is an SVG that must decode asynchronously; the texture is only uploaded once it is
 * ready, so the panel appears fully formed rather than flashing text before the logo pops in.
 * Returns the texture plus `isReady()` so the render loop can hold off drawing until then.
 */
function makePromptTexture(
  gl: WebGLRenderingContext,
  twoControllers: boolean,
): { texture: WebGLTexture; isReady(): boolean } {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;

  const lines = twoControllers
    ? ['Point both controllers forward', 'and squeeze one of the triggers', 'to continue']
    : ['Point your controller forward', 'and squeeze the trigger', 'to continue'];

  const draw = (wordmark: HTMLImageElement): void => {
    ctx.fillStyle = 'rgba(12,12,18,0.9)';
    roundRectPath(ctx, 4, 4, canvas.width - 8, canvas.height - 8, 18);
    ctx.fill();

    // Wordmark across the top, ~12% of the canvas height, vertically centred in the band between
    // the panel's top border (y=4) and the divider below it.
    const dividerY = 66;
    const h = canvas.height * 0.12;
    const w = h * WORDMARK_ASPECT;
    const logoTop = (4 + dividerY) / 2 - h / 2;
    ctx.drawImage(wordmark, (canvas.width - w) / 2, logoTop, w, h);

    // Divider under the logo, matching the setup sheet's #888 lines.
    ctx.strokeStyle = '#888';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(4, dividerY);
    ctx.lineTo(canvas.width - 4, dividerY);
    ctx.stroke();

    ctx.fillStyle = '#fff';
    ctx.font = '600 26px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Wrapped into short lines so none reaches the canvas edge. Vertically centred in the region
    // below the divider (down to the panel's bottom border).
    const cy = (dividerY + (canvas.height - 4)) / 2;
    lines.forEach((line, i) => {
      ctx.fillText(line, canvas.width / 2, cy + (i - (lines.length - 1) / 2) * 38);
    });

    // Panel border last so it sits crisp on top, matching the setup sheet's #888 border.
    ctx.strokeStyle = '#888';
    ctx.lineWidth = 3;
    roundRectPath(ctx, 4, 4, canvas.width - 8, canvas.height - 8, 18);
    ctx.stroke();
  };

  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  // Plain bilinear (no mipmaps — they over-soften at the mild minification here).
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  // Draw + upload only once the wordmark has decoded (a data URI, so effectively immediate).
  let ready = false;
  const img = new Image();
  img.onload = () => {
    draw(img);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); // canvas top row → texture top (with v=1 at +Y)
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    ready = true;
  };
  img.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(ZAPBOX_WORDMARK_SVG);

  return { texture: tex, isReady: () => ready };
}

/**
 * Owns the session briefly with our own GL layer, rendering a viewer-locked stereo prompt panel
 * until the user points a controller forward and squeezes a trigger. Then returns the recenter
 * offset transform to seed the session adapter with, and aligns each controller's forward. The
 * caller resolves the page's requestSession() promise only after this completes, so the page's own
 * render loop never overlaps.
 */
export function runCalibrationPreroll(
  session: XRSession,
  bindings: ControllerBinding[],
): Promise<XRRigidTransform> {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl', { xrCompatible: true }) as WebGLRenderingContext;

  // Program + interleaved quad (xy, uv) centred on the local origin; TRIANGLE_STRIP.
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT_SRC));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG_SRC));
  gl.linkProgram(program);
  gl.useProgram(program);

  const hw = QUAD_W / 2;
  const hh = QUAD_H / 2;
  const verts = new Float32Array([
    -hw, hh, 0, 1,
    -hw, -hh, 0, 0,
    hw, hh, 1, 1,
    hw, -hh, 1, 0,
  ]);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(program, 'aPos');
  const aUV = gl.getAttribLocation(program, 'aUV');
  gl.enableVertexAttribArray(aPos);
  gl.enableVertexAttribArray(aUV);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
  gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, 16, 8);
  const uMVP = gl.getUniformLocation(program, 'uMVP');

  const prompt = makePromptTexture(gl, bindings.length > 1);
  gl.uniform1i(gl.getUniformLocation(program, 'uTex'), 0);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  // Chrome's default framebufferScaleFactor is conservative; request native screen res for a sharper
  // prompt. (Chrome clamps to native — confirmed on device — so we can't oversample for true 1:1 in
  // the lens centre the way a native runtime can; native is the ceiling here.)
  const layer = new XRWebGLLayer(session, gl, {
    framebufferScaleFactor: XRWebGLLayer.getNativeFramebufferScaleFactor(session),
  });
  session.updateRenderState({ baseLayer: layer });

  // Scratch (avoid per-frame allocation).
  const fwdBase = vec3.fromValues(0, 0, -DISTANCE);
  const headQuat = quat.create();
  const centre = vec3.create();
  const model = mat4.create();
  const mvp = mat4.create();

  return new Promise<XRRigidTransform>((resolve) => {
    session.requestReferenceSpace('local').then((refSpace) => {
      let armed = false; // require a release→press so a held trigger doesn't skip calibration

      const onFrame: XRFrameRequestCallback = (_t, frame) => {
        const pose = frame.getViewerPose(refSpace);
        const glLayer = session.renderState.baseLayer!;
        gl.bindFramebuffer(gl.FRAMEBUFFER, glLayer.framebuffer);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        if (pose && prompt.isReady()) {
          // Model: panel centred DISTANCE in front of the head, oriented with the head (viewer-locked).
          const o = pose.transform.orientation;
          const p = pose.transform.position;
          quat.set(headQuat, o.x, o.y, o.z, o.w);
          vec3.transformQuat(centre, fwdBase, headQuat);
          centre[0] += p.x;
          centre[1] += p.y;
          centre[2] += p.z;
          mat4.fromRotationTranslation(model, headQuat, centre);

          for (const view of pose.views) {
            const vp = glLayer.getViewport(view)!;
            gl.viewport(vp.x, vp.y, vp.width, vp.height);
            // mvp = projection · viewMatrix · model  (per-eye view carries the IPD → stereo disparity)
            mat4.multiply(mvp, view.projectionMatrix, view.transform.inverse.matrix);
            mat4.multiply(mvp, mvp, model);
            gl.uniformMatrix4fv(uMVP, false, mvp as Float32Array);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
          }
        }

        const anyTrigger = bindings.some(b => b.controller.latestInputState.buttons.trigger);
        if (!anyTrigger) armed = true;

        if (armed && anyTrigger) {
          const gaze = pose ? headingFromOrientation(pose.transform.orientation) : { x: 0, z: -1 };
          const offset = recenterOffsetFromGaze(gaze.x, gaze.z);
          for (const b of bindings) b.controller.resetForward(0, -1);
          resolve(offset);
          return; // stop scheduling — the page takes over the loop after we resolve
        }

        session.requestAnimationFrame(onFrame);
      };

      session.requestAnimationFrame(onFrame);
    });
  });
}
