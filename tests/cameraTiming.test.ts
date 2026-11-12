import test from 'node:test';
import assert from 'node:assert/strict';
import {
  minutePrecisionAgeWindow,
  wallClockMs
} from '../src/services/cameraTiming.js';

test('minutePrecisionAgeWindow cobre a faixa plausivel dentro do mesmo minuto', () => {
  const current = Date.UTC(2026, 10, 12, 10, 13, 33);
  const window = minutePrecisionAgeWindow(
    '2026-11-12T10:13:00',
    current,
    100_000,
    1000
  );

  assert.deepEqual(window, {
    minAgeMs: 1000,
    maxAgeMs: 33_000
  });
});

test('minutePrecisionAgeWindow cobre batida do minuto anterior', () => {
  const current = Date.UTC(2026, 10, 12, 6, 49, 7);
  const window = minutePrecisionAgeWindow(
    '2026-11-12T06:48:00',
    current,
    100_000,
    1000
  );

  assert.deepEqual(window, {
    minAgeMs: 7001,
    maxAgeMs: 67_000
  });
});

test('minutePrecisionAgeWindow respeita o limite real do buffer', () => {
  const current = Date.UTC(2026, 10, 12, 6, 41, 17);
  const window = minutePrecisionAgeWindow(
    '2026-11-12T06:40:00',
    current,
    60_000,
    1000
  );

  assert.deepEqual(window, {
    minAgeMs: 17_001,
    maxAgeMs: 59_000
  });
});

test('wallClockMs rejeita valor invalido', () => {
  assert.equal(wallClockMs('invalido'), null);
});
