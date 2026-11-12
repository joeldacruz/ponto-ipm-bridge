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

  // Amostragem em grade 2x2 reduz CPU sem perder alteracoes humanas relevantes.
  const step = 2;
  let totalDifference = 0;
  let samples = 0;

  for (let y = startY; y < endY; y += step) {
    for (let x = startX; x < endX; x += step) {
      const index = (y * width + x) * 4;

      const referenceLuma = (
        Number(reference.data[index]) * 77 +
        Number(reference.data[index + 1]) * 150 +
        Number(reference.data[index + 2]) * 29
      ) >> 8;

      const candidateLuma = (
        Number(candidate.data[index]) * 77 +
        Number(candidate.data[index + 1]) * 150 +
        Number(candidate.data[index + 2]) * 29
      ) >> 8;

      totalDifference += Math.abs(referenceLuma - candidateLuma);
      samples += 1;
    }
  }

  if (samples === 0) return null;
  return totalDifference / (samples * 255);
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
