/**
 * Can this device's graphics run the heavy ArtCraft web apps? They need 8192-pixel textures
 * (WebGPU or WebGL2). Checked once at start; most phones and tablets can't.
 */
const NEED = 8192;
let strong: boolean | null = null;

function webgl(): number {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    return gl ? (gl.getParameter(gl.MAX_TEXTURE_SIZE) as number) : 0;
  } catch {
    return 0;
  }
}

export const gpuReady: Promise<boolean> = (async () => {
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<{ limits: { maxTextureDimension2D: number } } | null> } }).gpu;
    const a = gpu ? await gpu.requestAdapter() : null;
    strong = (a?.limits.maxTextureDimension2D ?? 0) >= NEED || webgl() >= NEED;
  } catch {
    strong = webgl() >= NEED;
  }
  return strong;
})();

/** null until the check has run. */
export const gpuStrong = () => strong;
