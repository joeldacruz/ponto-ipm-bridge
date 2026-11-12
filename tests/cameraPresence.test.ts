import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseBestPresenceCandidate,
  parsePresenceRoi,
  scorePresenceDifference,
  type RawRgbaImage
} from '../src/services/cameraPresence.js';

function solidImage(width: number, height: number, value: number): RawRgbaImage {
  const data = new Uint8Array(width * height * 4);

  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    data[offset] = value;
    data[offset + 1] = value;
    data[offset + 2] = value;
    data[offset + 3] = 255;
  }

  return { width, height, data };
}

function paintRectangle(
  image: RawRgbaImage,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  value: number
): void {
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const offset = (y * image.width + x) * 4;
      image.data[offset] = value;
      image.data[offset + 1] = value;
      image.data[offset + 2] = value;
    }
  }
}

test('scorePresenceDifference considera somente a ROI configurada', () => {
  const reference = solidImage(100, 100, 100);
  const outside = solidImage(100, 100, 100);
  const inside = solidImage(100, 100, 100);
  const roi = { x: 0, y: 0, width: 0.4, height: 1 };

  paintRectangle(outside, 70, 20, 95, 80, 220);
  paintRectangle(inside, 5, 20, 30, 80, 220);

  const outsideScore = scorePresenceDifference(reference, outside, roi);
  const insideScore = scorePresenceDifference(reference, inside, roi);

  assert.equal(outsideScore, 0);
  assert.ok(insideScore != null && insideScore > 0.1);
});

test('chooseBestPresenceCandidate escolhe maior presença e desempata pelo fallback', () => {
  const best = chooseBestPresenceCandidate([
    { value: '2500', score: 0.03, distanceFromPreferredMs: 0 },
    { value: '1200', score: 0.08, distanceFromPreferredMs: 1300 },
    { value: '0', score: 0.08, distanceFromPreferredMs: 2500 }
  ], 0.012);

  assert.equal(best, '1200');
});

test('chooseBestPresenceCandidate retorna null abaixo do limiar', () => {
  const best = chooseBestPresenceCandidate([
    { value: '2500', score: 0.003, distanceFromPreferredMs: 0 },
    { value: '1200', score: 0.005, distanceFromPreferredMs: 1300 }
  ], 0.012);

  assert.equal(best, null);
});

test('parsePresenceRoi aceita ROI normalizada e rejeita valores inválidos', () => {
  assert.deepEqual(
    parsePresenceRoi('0.1,0.2,0.3,0.4'),
    { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }
  );

  assert.deepEqual(
    parsePresenceRoi('0.9,0,0.5,1'),
    { x: 0, y: 0.05, width: 0.38, height: 0.85 }
  );
});
