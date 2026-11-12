export type PresenceRoi = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type RawRgbaImage = {
  width: number;
  height: number;
  data: Uint8Array | Buffer;
};

export type PresenceCandidate<T> = {
  value: T;
  score: number | null;
  distanceFromPreferredMs: number;
};

export function parsePresenceRoi(value: string | undefined): PresenceRoi {
  const fallback: PresenceRoi = {
    x: 0,
    y: 0.05,
    width: 0.38,
    height: 0.85
  };

  const parts = String(value || '')
    .split(',')
    .map((item) => Number(item.trim()));

  if (parts.length !== 4 || parts.some((item) => !Number.isFinite(item))) {
    return fallback;
  }

  const [x, y, width, height] = parts;

  if (
    x < 0 || x >= 1 ||
    y < 0 || y >= 1 ||
    width <= 0 || height <= 0 ||
    x + width > 1 ||
    y + height > 1
  ) {
    return fallback;
  }

  return { x, y, width, height };
}

export function scorePresenceDifference(
  reference: RawRgbaImage,
  candidate: RawRgbaImage,
  roi: PresenceRoi
): number | null {
  if (
    reference.width <= 0 ||
    reference.height <= 0 ||
    candidate.width !== reference.width ||
    candidate.height !== reference.height
  ) {
    return null;
  }

  const width = reference.width;
  const height = reference.height;
  const startX = Math.max(0, Math.floor(width * roi.x));
  const startY = Math.max(0, Math.floor(height * roi.y));
  const endX = Math.min(width, Math.ceil(width * (roi.x + roi.width)));
  const endY = Math.min(height, Math.ceil(height * (roi.y + roi.height)));

  if (endX <= startX || endY <= startY) return null;

  // Amostragem em grade 2x2 reduz CPU. Primeiro medimos a variacao global
  // de luminosidade para compensar autoexposicao/luzes da camera.
  const step = 2;
  let referenceSum = 0;
  let candidateSum = 0;
  let samples = 0;

  const luma = (image: RawRgbaImage, index: number): number => (
    Number(image.data[index]) * 77 +
    Number(image.data[index + 1]) * 150 +
    Number(image.data[index + 2]) * 29
  ) >> 8;

  for (let y = startY; y < endY; y += step) {
    for (let x = startX; x < endX; x += step) {
      const index = (y * width + x) * 4;
      referenceSum += luma(reference, index);
      candidateSum += luma(candidate, index);
      samples += 1;
    }
  }

  if (samples === 0) return null;

  const globalShift = (candidateSum - referenceSum) / samples;
  let changedPixels = 0;

  // Depois da compensacao, conta apenas mudancas locais relevantes.
  // Uma pessoa ocupa uma fracao significativa da ROI; uma mudanca uniforme
  // de iluminacao tende a desaparecer neste calculo.
  const localDifferenceThreshold = 20;

  for (let y = startY; y < endY; y += step) {
    for (let x = startX; x < endX; x += step) {
      const index = (y * width + x) * 4;
      const residual = Math.abs(
        (luma(candidate, index) - luma(reference, index)) - globalShift
      );

      if (residual >= localDifferenceThreshold) {
        changedPixels += 1;
      }
    }
  }

  return changedPixels / samples;
}

export function chooseBestPresenceCandidate<T>(
  candidates: PresenceCandidate<T>[],
  minimumDifference: number
): T | null {
  const valid = candidates
    .filter((candidate): candidate is PresenceCandidate<T> & { score: number } =>
      candidate.score != null && Number.isFinite(candidate.score)
    )
    .filter((candidate) => candidate.score >= minimumDifference)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.distanceFromPreferredMs - right.distanceFromPreferredMs;
    });

  return valid[0]?.value ?? null;
}
