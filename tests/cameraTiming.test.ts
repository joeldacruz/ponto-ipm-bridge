import test from 'node:test';
import assert from 'node:assert/strict';
import { eventEpochFromWallClock, wallClockMs } from '../src/services/cameraTiming.js';

test('wallClockMs interpreta horario local sem aplicar timezone do processo', () => {
  assert.equal(
    wallClockMs('2026-11-12T09:02:10'),
    Date.UTC(2026, 10, 12, 9, 2, 10)
  );
});

test('eventEpochFromWallClock ancora o frame no horario real informado pelo REP', () => {
  const nowEpochMs = Date.UTC(2026, 10, 12, 12, 2, 17, 700);
  const currentWallClockEpochMs = Date.UTC(2026, 10, 12, 9, 2, 17);

  const eventEpochMs = eventEpochFromWallClock(
    '2026-11-12T09:02:10',
    nowEpochMs,
    currentWallClockEpochMs
  );

  assert.equal(
    eventEpochMs,
    Date.UTC(2026, 10, 12, 12, 2, 10, 700)
  );
});

test('eventEpochFromWallClock retorna null para horario invalido', () => {
  assert.equal(
    eventEpochFromWallClock(
      'invalido',
      Date.now(),
      Date.now()
    ),
    null
  );
});
