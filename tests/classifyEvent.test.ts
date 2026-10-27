import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyEvent } from '../src/core/classifyEvent.js';

test('sem attendanceStatus é acesso', () => {
  assert.equal(classifyEvent(undefined), 'ACCESS');
  assert.equal(classifyEvent(''), 'ACCESS');
});

test('status de frequência é ponto', () => {
  assert.equal(classifyEvent('checkIn'), 'ATTENDANCE');
  assert.equal(classifyEvent('checkOut'), 'ATTENDANCE');
});
