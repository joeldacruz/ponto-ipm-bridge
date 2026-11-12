import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import jpeg from 'jpeg-js';
import type { DeviceEvent } from '../core/types.js';
import {
  chooseBestPresenceCandidate,
  parsePresenceRoi,
  scorePresenceDifference,
  type RawRgbaImage
} from './cameraPresence.js';
import { minutePrecisionAgeWindow, wallClockMs } from './cameraTiming.js';

type BufferedFrame = {
  capturedAt: number;
  data: Buffer;
};

export type AttendancePhotoCapture = {
  relativePath: string;
  capturedAt: string;
  frameAt: string;
};

function envEnabled(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function boundedNumber(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function boundedNumberList(
  value: string | undefined,
  fallback: number[],
  min: number,
  max: number
): number[] {
  const parsed = String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item))
    .map((item) => Math.min(max, Math.max(min, item)));

  const values = parsed.length ? parsed : fallback;
  return [...new Set(values)].slice(0, 6);
}

const enabled = envEnabled(process.env.ATTENDANCE_CAMERA_ENABLED);
const rtspUrl = String(process.env.ATTENDANCE_CAMERA_RTSP_URL || '').trim();
const cameraDeviceId = String(process.env.ATTENDANCE_CAMERA_DEVICE_ID || 'rep-topdata-02').trim();
const cameraFps = boundedNumber(process.env.ATTENDANCE_CAMERA_BUFFER_FPS, 2, 1, 5);
const bufferSeconds = boundedNumber(process.env.ATTENDANCE_CAMERA_BUFFER_SECONDS, 100, 20, 120);
const captureOffsetMs = boundedNumber(process.env.ATTENDANCE_CAMERA_CAPTURE_OFFSET_MS, 2500, 0, 15000);
const presenceSelectionEnabled = envEnabled(
  process.env.ATTENDANCE_CAMERA_PRESENCE_SELECTION_ENABLED ?? '1'
);
const captureCandidateOffsetsMs = boundedNumberList(
  process.env.ATTENDANCE_CAMERA_SCAN_OFFSETS_MS,
  [0, 2000, 4000, 6000, 8000, 10000],
  0,
  Math.max(0, bufferSeconds * 1000 - 1000)
);
if (!captureCandidateOffsetsMs.includes(captureOffsetMs)) {
  captureCandidateOffsetsMs.push(captureOffsetMs);
}
captureCandidateOffsetsMs.sort((left, right) => left - right);

const referenceOffsetMs = boundedNumber(
  process.env.ATTENDANCE_CAMERA_SCAN_REFERENCE_OFFSET_MS,
  14000,
  1000,
  Math.max(1000, bufferSeconds * 1000 - 500)
);
const minuteScanStepMs = boundedNumber(
  process.env.ATTENDANCE_CAMERA_MINUTE_SCAN_STEP_MS,
  2000,
  500,
  5000
);
const minuteMinimumCandidateAgeMs = boundedNumber(
  process.env.ATTENDANCE_CAMERA_MINUTE_MIN_AGE_MS,
  1000,
  500,
  5000
);
const minuteBackgroundGapMs = boundedNumber(
  process.env.ATTENDANCE_CAMERA_MINUTE_BACKGROUND_GAP_MS,
  3000,
  1000,
  10000
);
const presenceMinimumDifference = boundedNumber(
  process.env.ATTENDANCE_CAMERA_PRESENCE_MIN_DIFFERENCE,
  0.025,
  0,
  1
);
const presenceRoi = parsePresenceRoi(process.env.ATTENDANCE_CAMERA_PRESENCE_ROI);
const eventMaxAgeSeconds = boundedNumber(process.env.ATTENDANCE_CAMERA_EVENT_MAX_AGE_SECONDS, 90, 10, 600);
const retentionDays = boundedNumber(process.env.ATTENDANCE_PHOTO_RETENTION_DAYS, 90, 1, 3650);
const photoRoot = path.resolve(process.env.ATTENDANCE_PHOTO_DIR || './data/attendance-photos');
const attendanceTimeZone = String(process.env.ATTENDANCE_TIMEZONE || 'America/Sao_Paulo').trim();

let frames: BufferedFrame[] = [];
let ffmpeg: ChildProcess | null = null;
let restartTimer: NodeJS.Timeout | null = null;
let retentionTimer: NodeJS.Timeout | null = null;
let stopping = false;
let lastFrameAt: number | null = null;
let streamStartedAt: number | null = null;

function cameraConfigured(): boolean {
  return enabled && rtspUrl.length > 0;
}

function pushFrame(data: Buffer): void {
  const capturedAt = Date.now();
  frames.push({ capturedAt, data: Buffer.from(data) });
  lastFrameAt = capturedAt;

  const maxFrames = Math.ceil(cameraFps * bufferSeconds) + 5;
  if (frames.length > maxFrames) {
    frames.splice(0, frames.length - maxFrames);
  }

  const oldestAllowed = capturedAt - (bufferSeconds * 1000);
  while (frames.length > 1 && frames[0].capturedAt < oldestAllowed) {
    frames.shift();
  }
}

function startFfmpeg(): void {
  if (!cameraConfigured() || ffmpeg || stopping) return;

  const child = spawn('ffmpeg', [
    '-hide_banner',
    '-loglevel', 'error',
    '-rtsp_transport', 'tcp',
    '-i', rtspUrl,
    '-an',
    '-vf', `fps=${cameraFps}`,
    '-q:v', '5',
    '-f', 'image2pipe',
    '-vcodec', 'mjpeg',
    'pipe:1'
  ], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  ffmpeg = child;
  streamStartedAt = Date.now();

  let pending = Buffer.alloc(0);
  const startMarker = Buffer.from([0xff, 0xd8]);
  const endMarker = Buffer.from([0xff, 0xd9]);

  child.stdout?.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);

    while (pending.length > 0) {
      const start = pending.indexOf(startMarker);
      if (start < 0) {
        pending = pending.subarray(Math.max(0, pending.length - 1));
        return;
      }

      if (start > 0) pending = pending.subarray(start);

      const end = pending.indexOf(endMarker, 2);
      if (end < 0) {
        if (pending.length > 10 * 1024 * 1024) pending = Buffer.alloc(0);
        return;
      }

      pushFrame(pending.subarray(0, end + 2));
      pending = pending.subarray(end + 2);
    }
  });

  // Consome stderr para impedir bloqueio do processo. Não registramos o texto,
  // pois mensagens do ffmpeg podem repetir a URL RTSP com credenciais.
  child.stderr?.on('data', () => {});

  child.on('error', () => {
    console.error('Camera de ponto: nao foi possivel iniciar o ffmpeg.');
  });

  child.on('exit', () => {
    if (ffmpeg === child) ffmpeg = null;
    frames = [];
    lastFrameAt = null;

    if (!stopping && cameraConfigured()) {
      restartTimer = setTimeout(startFfmpeg, 5000);
      restartTimer.unref();
    }
  });
}

function pruneDirectory(dir: string, cutoffMs: number): void {
  if (!fs.existsSync(dir)) return;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      pruneDirectory(full, cutoffMs);
      try {
        if (fs.readdirSync(full).length === 0) fs.rmdirSync(full);
      } catch {
        // Outra captura pode ter criado arquivo no intervalo.
      }
      continue;
    }

    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.jpg')) continue;

    try {
      const stat = fs.statSync(full);
      if (stat.mtimeMs < cutoffMs) fs.unlinkSync(full);
    } catch {
      // A limpeza é best-effort; nunca derruba a coleta de ponto.
    }
  }
}

function pruneOldPhotos(): void {
  const cutoff = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
  try {
    pruneDirectory(photoRoot, cutoff);
  } catch {
    console.error('Camera de ponto: falha ao executar limpeza de fotos antigas.');
  }
}

export function startAttendanceCamera(): void {
  if (!cameraConfigured()) {
    console.log('Camera de ponto: desativada ou sem URL RTSP configurada.');
    return;
  }

  fs.mkdirSync(photoRoot, { recursive: true });
  pruneOldPhotos();

  retentionTimer = setInterval(pruneOldPhotos, 6 * 60 * 60 * 1000);
  retentionTimer.unref();

  startFfmpeg();
  console.log('Camera de ponto: buffer RTSP iniciado.');
}

export function stopAttendanceCamera(): void {
  stopping = true;
  if (restartTimer) clearTimeout(restartTimer);
  if (retentionTimer) clearInterval(retentionTimer);
  restartTimer = null;
  retentionTimer = null;

  if (ffmpeg) {
    ffmpeg.kill('SIGTERM');
    ffmpeg = null;
  }

  frames = [];
}

function currentWallClockMs(): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: attendanceTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date());

  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );

  return Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second)
  );
}

function eventIsRecent(event: DeviceEvent): boolean {
  const occurredAt = wallClockMs(event.occurredAt);
  if (occurredAt == null) return false;

  const age = currentWallClockMs() - occurredAt;
  return age >= -30_000 && age <= eventMaxAgeSeconds * 1000;
}

function selectBufferedFrame(targetMs: number, maxDistanceMs?: number): BufferedFrame | null {
  if (!frames.length) return null;

  let best = frames[0];
  let bestDistance = Math.abs(best.capturedAt - targetMs);

  for (let index = 1; index < frames.length; index += 1) {
    const current = frames[index];
    const distance = Math.abs(current.capturedAt - targetMs);
    if (distance < bestDistance) {
      best = current;
      bestDistance = distance;
    }
  }

  if (Date.now() - best.capturedAt > (bufferSeconds * 1000) + 5000) return null;
  if (maxDistanceMs != null && bestDistance > maxDistanceMs) return null;
  return best;
}

function decodeBufferedFrame(frame: BufferedFrame): RawRgbaImage | null {
  try {
    return jpeg.decode(frame.data, {
      useTArray: true,
      formatAsRGBA: true,
      tolerantDecoding: true,
      maxResolutionInMP: 5,
      maxMemoryUsageInMB: 64
    });
  } catch {
    return null;
  }
}

function selectByPresence(
  preferred: BufferedFrame,
  reference: BufferedFrame | null,
  candidates: BufferedFrame[],
  preferredTargetMs: number
): BufferedFrame {
  if (!presenceSelectionEnabled || !reference || candidates.length < 2) return preferred;

  const referenceImage = decodeBufferedFrame(reference);
  if (!referenceImage) return preferred;

  const scored = candidates.map((candidate) => {
    const candidateImage = decodeBufferedFrame(candidate);
    return {
      value: candidate,
      score: candidateImage == null
        ? null
        : scorePresenceDifference(referenceImage, candidateImage, presenceRoi),
      distanceFromPreferredMs: Math.abs(candidate.capturedAt - preferredTargetMs)
    };
  });

  return chooseBestPresenceCandidate(scored, presenceMinimumDifference) ?? preferred;
}

function receiptWindowCandidateFrames(nowMs: number): BufferedFrame[] {
  const unique = new Map<number, BufferedFrame>();

  for (const offsetMs of captureCandidateOffsetsMs) {
    const frame = selectBufferedFrame(nowMs - offsetMs);
    if (frame) unique.set(frame.capturedAt, frame);
  }

  return [...unique.values()];
}

function selectAttendanceFrameByReceiptWindow(nowMs: number): BufferedFrame | null {
  const preferredTargetMs = nowMs - captureOffsetMs;
  const preferred = selectBufferedFrame(preferredTargetMs);
  if (!preferred) return null;

  return selectByPresence(
    preferred,
    selectBufferedFrame(nowMs - referenceOffsetMs),
    receiptWindowCandidateFrames(nowMs),
    preferredTargetMs
  );
}

function minuteWindowCandidateFrames(
  nowMs: number,
  minAgeMs: number,
  maxAgeMs: number,
  preferredAgeMs: number
): BufferedFrame[] {
  const unique = new Map<number, BufferedFrame>();
  const ages = new Set<number>([minAgeMs, maxAgeMs, preferredAgeMs]);

  for (let ageMs = minAgeMs; ageMs <= maxAgeMs; ageMs += minuteScanStepMs) {
    ages.add(ageMs);
  }

  const maxDistanceMs = Math.max(1000, Math.ceil(1500 / cameraFps));

  for (const ageMs of [...ages].sort((left, right) => left - right)) {
    const frame = selectBufferedFrame(nowMs - ageMs, maxDistanceMs);
    if (frame) unique.set(frame.capturedAt, frame);
  }

  return [...unique.values()];
}

function selectAttendanceFrame(event: DeviceEvent, nowMs: number): BufferedFrame | null {
  const window = minutePrecisionAgeWindow(
    event.occurredAt,
    currentWallClockMs(),
    bufferSeconds * 1000,
    minuteMinimumCandidateAgeMs
  );

  if (!window) return selectAttendanceFrameByReceiptWindow(nowMs);

  const preferredAgeMs = Math.min(
    window.maxAgeMs,
    Math.max(window.minAgeMs, captureOffsetMs)
  );

  const preferredTargetMs = nowMs - preferredAgeMs;
  const preferred = selectBufferedFrame(preferredTargetMs);
  if (!preferred) return selectAttendanceFrameByReceiptWindow(nowMs);

  const preMinuteReferenceAgeMs = window.maxAgeMs + minuteBackgroundGapMs;
  const maxReferenceDistanceMs = Math.max(1000, Math.ceil(1500 / cameraFps));

  const reference =
    selectBufferedFrame(
      nowMs - preMinuteReferenceAgeMs,
      maxReferenceDistanceMs
    )
    ?? selectBufferedFrame(nowMs, maxReferenceDistanceMs);

  return selectByPresence(
    preferred,
    reference,
    minuteWindowCandidateFrames(
      nowMs,
      window.minAgeMs,
      window.maxAgeMs,
      preferredAgeMs
    ),
    preferredTargetMs
  );
}

function eventPhotoRelativePath(eventId: number, event: DeviceEvent): string {
  const date = /^\d{4}-\d{2}-\d{2}/.exec(event.occurredAt)?.[0] || new Date().toISOString().slice(0, 10);
  const [year, month, day] = date.split('-');
  const nsr = event.nsr == null ? 'sem-nsr' : String(event.nsr);
  return path.join(year, month, day, `evento-${eventId}-nsr-${nsr}.jpg`);
}

export function captureAttendancePhoto(
  eventId: number,
  event: DeviceEvent
): AttendancePhotoCapture | null {
  if (!cameraConfigured()) return null;
  if (event.kind !== 'ATTENDANCE') return null;
  if (event.deviceId !== cameraDeviceId) return null;
  if (!eventIsRecent(event)) return null;

  const frame = selectAttendanceFrame(event, Date.now());
  if (!frame) return null;

  const relativePath = eventPhotoRelativePath(eventId, event);
  const absolutePath = resolveAttendancePhotoPath(relativePath);
  if (!absolutePath) return null;

  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });

  const tempPath = absolutePath + '.tmp';
  fs.writeFileSync(tempPath, frame.data);
  fs.renameSync(tempPath, absolutePath);

  const now = new Date();
  return {
    relativePath,
    capturedAt: now.toISOString(),
    frameAt: new Date(frame.capturedAt).toISOString()
  };
}

export function resolveAttendancePhotoPath(relativePath: string): string | null {
  const absolute = path.resolve(photoRoot, relativePath);
  const rootPrefix = photoRoot.endsWith(path.sep) ? photoRoot : photoRoot + path.sep;
  if (absolute !== photoRoot && !absolute.startsWith(rootPrefix)) return null;
  return absolute;
}

export function getAttendanceCameraStatus() {
  const now = Date.now();
  const ready = cameraConfigured()
    && lastFrameAt != null
    && (now - lastFrameAt) <= 5000;

  return {
    enabled: cameraConfigured(),
    ready,
    deviceId: cameraDeviceId,
    bufferedFrames: frames.length,
    lastFrameAt: lastFrameAt == null ? null : new Date(lastFrameAt).toISOString(),
    streamStartedAt: streamStartedAt == null ? null : new Date(streamStartedAt).toISOString(),
    selectionMode: presenceSelectionEnabled ? 'minute-window-presence-roi' : 'fixed-offset',
    captureOffsetMs,
    bufferSeconds,
    minuteScanStepMs,
    minuteMinimumCandidateAgeMs,
    minuteBackgroundGapMs,
    fallbackScanOffsetsMs: captureCandidateOffsetsMs,
    fallbackReferenceOffsetMs: referenceOffsetMs,
    presenceMinimumDifference,
    presenceRoi
  };
}
