// Local, approximate visual preview. This code never communicates with the camera.
const $ = (id) => document.getElementById(id);
const clamp = (value) => Math.max(0, Math.min(1, value));

const NEUTRAL = Object.freeze({
  film: 1, whiteBalance: 2, kelvin: 5500, whiteBalanceRed: 0,
  whiteBalanceBlue: 0, highlight: 0, shadow: 0, color: 0,
  grain: 1, chrome: 1, blueChrome: 1, clarity: 0,
  sharpness: 0, dynamicRange: 100, priority: 0,
  monoWarmCool: 0, monoMagentaGreen: 0,
});

const FILM_LOOK = Object.freeze({
  1: { saturation: 1, contrast: 1, rgb: [1, 1, 1] },
  2: { saturation: 1.34, contrast: 1.12, rgb: [1.03, 1.01, 1.02] },
  3: { saturation: 0.92, contrast: 0.94, rgb: [1.04, 1, 0.98] },
  4: { saturation: 0.86, contrast: 1.1, rgb: [1.03, 1, 0.99] },
  5: { saturation: 0.78, contrast: 0.93, rgb: [1.02, 1, 0.99] },
  6: { saturation: 0, contrast: 1.02, rgb: [1, 1, 1] },
  7: { saturation: 0, contrast: 1.02, rgb: [1, 1, 1] },
  8: { saturation: 0, contrast: 1.02, rgb: [1, 1, 1] },
  9: { saturation: 0, contrast: 1.02, rgb: [1, 1, 1] },
  10: { saturation: 0, contrast: 1.01, rgb: [1, 1, 1] },
  11: { saturation: 0.7, contrast: 1.08, rgb: [1.05, 1, 0.93] },
  12: { saturation: 0, contrast: 1.12, rgb: [1, 1, 1] },
  13: { saturation: 0, contrast: 1.12, rgb: [1, 1, 1] },
  14: { saturation: 0, contrast: 1.12, rgb: [1, 1, 1] },
  15: { saturation: 0, contrast: 1.12, rgb: [1, 1, 1] },
  16: { saturation: 0.72, contrast: 0.87, rgb: [1, 1, 1.03] },
  17: { saturation: 0.82, contrast: 1.2, rgb: [1.07, 1, 0.95] },
  18: { saturation: 0.48, contrast: 1.23, rgb: [1.02, 1, 0.95] },
});

function channelWeights(film) {
  // Colored filters affect monochrome conversion. Values are visual hints.
  if ([7, 13].includes(film)) return [0.29, 0.59, 0.12];
  if ([8, 14].includes(film)) return [0.4, 0.5, 0.1];
  if ([9, 15].includes(film)) return [0.16, 0.72, 0.12];
  return [0.2126, 0.7152, 0.0722];
}

function temperatureBalance(recipe) {
  const wb = Number(recipe.whiteBalance);
  let warm = 0;
  if (wb === 0x8007) warm = Math.max(-1, Math.min(1, (Number(recipe.kelvin) - 5500) / 3500));
  else if (wb === 4) warm = 0.07;
  else if (wb === 0x8006) warm = 0.13;
  else if (wb === 6) warm = -0.12;
  else if ([0x8001, 0x8002, 0x8003].includes(wb)) warm = -0.08;
  else if (wb === 0x8020) warm = -0.05;
  else if (wb === 0x8021) warm = 0.08;
  const red = 1 + warm * 0.22 + Number(recipe.whiteBalanceRed) * 0.025;
  const blue = 1 - warm * 0.22 + Number(recipe.whiteBalanceBlue) * 0.025;
  return [red, blue];
}

function grainAt(x, y, size) {
  const gx = Math.floor(x / size), gy = Math.floor(y / size);
  let seed = Math.imul(gx + 12457, 374761393) + Math.imul(gy + 7319, 668265263);
  seed = Math.imul(seed ^ (seed >>> 13), 1274126177);
  return ((seed ^ (seed >>> 16)) >>> 0) / 4294967295 - 0.5;
}

function processPixels(source, width, height, recipe) {
  const result = new ImageData(width, height);
  const input = source.data, output = result.data;
  const film = Number(recipe.film), style = FILM_LOOK[film] ?? FILM_LOOK[1];
  const mono = style.saturation === 0;
  const weights = channelWeights(film);
  const [redBalance, blueBalance] = temperatureBalance(recipe);
  const saturation = style.saturation * (1 + Number(recipe.color) * 0.13);
  const contrast = style.contrast;
  const priority = Number(recipe.priority);
  const highlight = priority ? 0 : Number(recipe.highlight);
  const shadow = priority ? 0 : Number(recipe.shadow);
  const chrome = Math.max(0, Number(recipe.chrome) - 1) * 0.075;
  const blueChrome = Math.max(0, Number(recipe.blueChrome) - 1) * 0.1;
  const grain = Number(recipe.grain);
  const grainStrength = grain === 1 ? 0 : ([2, 4].includes(grain) ? 0.065 : 0.13);
  const grainSize = [4, 5].includes(grain) ? 5 : 2;
  const sharpness = Number(recipe.sharpness);
  const clarity = Number(recipe.clarity);
  const warmCool = Number(recipe.monoWarmCool);
  const magentaGreen = Number(recipe.monoMagentaGreen);
  const range = priority ? (priority === 2 ? 0.09 : 0.05)
    : Number(recipe.dynamicRange) === 400 ? 0.055 : Number(recipe.dynamicRange) === 200 ? 0.03 : 0;
  const getLuma = (x, y) => {
    const nx = Math.max(0, Math.min(width - 1, x));
    const ny = Math.max(0, Math.min(height - 1, y));
    const i = (ny * width + nx) * 4;
    return (input[i] * 0.2126 + input[i + 1] * 0.7152 + input[i + 2] * 0.0722) / 255;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      let r = input[i] / 255 * redBalance * style.rgb[0];
      let g = input[i + 1] / 255 * style.rgb[1];
      let b = input[i + 2] / 255 * blueBalance * style.rgb[2];
      let luma = r * 0.2126 + g * 0.7152 + b * 0.0722;

      if (mono) {
        const gray = r * weights[0] + g * weights[1] + b * weights[2];
        if (film === 10) {
          r = gray * 1.12; g = gray * 1.02; b = gray * 0.79;
        } else {
          r = gray * (1 + warmCool * 0.012 + magentaGreen * 0.004);
          g = gray * (1 - magentaGreen * 0.005);
          b = gray * (1 - warmCool * 0.012 + magentaGreen * 0.004);
        }
      } else {
        r = luma + (r - luma) * saturation;
        g = luma + (g - luma) * saturation;
        b = luma + (b - luma) * saturation;
        const chroma = Math.max(r, g, b) - Math.min(r, g, b);
        const shadowWeight = Math.max(0, 1 - luma);
        const chromeBoost = chrome * chroma * shadowWeight;
        r += (r - luma) * chromeBoost;
        g += (g - luma) * chromeBoost;
        b += (b - luma) * chromeBoost;
        const blueness = Math.max(0, b - Math.max(r, g));
        b -= blueness * blueChrome * 1.6;
      }

      // Positive Fuji shadow values harden dark areas; positive highlight values lift lights.
      const tone = (luma - 0.5) * (contrast - 1)
        - shadow * 0.036 * Math.pow(1 - luma, 2)
        + highlight * 0.035 * luma * luma
        - range * Math.max(0, luma - 0.6);
      r += tone; g += tone; b += tone;

      if (sharpness || clarity) {
        const center = getLuma(x, y);
        let edge = 0;
        if (sharpness) {
          const nearby = (getLuma(x - 1, y) + getLuma(x + 1, y) + getLuma(x, y - 1) + getLuma(x, y + 1)) / 4;
          edge += (center - nearby) * sharpness * 0.65;
        }
        if (clarity) {
          const broad = (getLuma(x - 6, y) + getLuma(x + 6, y) + getLuma(x, y - 6) + getLuma(x, y + 6)) / 4;
          edge += (center - broad) * clarity * 0.2;
        }
        r += edge; g += edge; b += edge;
      }

      if (grainStrength) {
        const noise = grainAt(x, y, grainSize) * grainStrength;
        r += noise; g += noise; b += noise;
      }
      output[i] = Math.round(clamp(r) * 255);
      output[i + 1] = Math.round(clamp(g) * 255);
      output[i + 2] = Math.round(clamp(b) * 255);
      output[i + 3] = input[i + 3];
    }
  }
  return result;
}

export function createPreview() {
  const before = $("previewBefore"), after = $("previewAfter");
  const status = $("previewStatus"), sourceLabel = $("previewSource");
  const fileControl = $("previewFile"), reset = $("previewReset");
  let sourcePixels = null, currentRecipe = NEUTRAL, localURL = null;
  let loadNumber = 0, frame = 0, previousSignature = "";

  function scheduleRender() {
    if (!sourcePixels || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const signature = JSON.stringify(currentRecipe);
      if (signature === previousSignature) return;
      previousSignature = signature;
      try {
        const image = processPixels(sourcePixels, before.width, before.height, currentRecipe);
        after.getContext("2d").putImageData(image, 0, 0);
        status.textContent = Number(currentRecipe.priority)
          ? "预览已更新。动态范围优先由相机自动处理高光和阴影，这里仅作示意。"
          : "预览已更新。";
        status.classList.remove("error");
      } catch (error) {
        status.textContent = `无法生成预览：${error.message}`;
        status.classList.add("error");
      }
    });
  }

  function loadImage(url, label) {
    const number = ++loadNumber;
    status.textContent = "正在加载照片…";
    status.classList.remove("error");
    const image = new Image();
    image.onload = () => {
      if (number !== loadNumber) return;
      const scale = Math.min(1, 800 / image.naturalWidth, 600 / image.naturalHeight);
      const width = Math.max(1, Math.round(image.naturalWidth * scale));
      const height = Math.max(1, Math.round(image.naturalHeight * scale));
      before.width = after.width = width;
      before.height = after.height = height;
      const context = before.getContext("2d", { willReadFrequently: true });
      context.drawImage(image, 0, 0, width, height);
      try {
        sourcePixels = context.getImageData(0, 0, width, height);
        sourceLabel.textContent = label;
        previousSignature = "";
        scheduleRender();
      } catch (error) {
        status.textContent = `无法读取照片：${error.message}`;
        status.classList.add("error");
      }
    };
    image.onerror = () => {
      if (number !== loadNumber) return;
      sourcePixels = null;
      status.textContent = "参考图未找到。可以选择一张电脑里的照片预览。";
      status.classList.add("error");
    };
    image.src = url;
  }

  fileControl.addEventListener("change", () => {
    const file = fileControl.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      status.textContent = "请选择图片文件。";
      status.classList.add("error");
      return;
    }
    if (localURL) URL.revokeObjectURL(localURL);
    localURL = URL.createObjectURL(file);
    loadImage(localURL, file.name);
  });
  reset.addEventListener("click", () => {
    fileControl.value = "";
    if (localURL) URL.revokeObjectURL(localURL);
    localURL = null;
    loadImage("./reference.jpg", "默认参考图");
  });

  loadImage("./reference.jpg", "默认参考图");
  return (recipe) => {
    currentRecipe = { ...NEUTRAL, ...(recipe ?? {}) };
    scheduleRender();
  };
}
