'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  advancePlaybackState,
  courseReleaseAccess,
  isLessonSequenceUnlocked
} = require('../course-policy');

const NOW = Date.parse('2026-08-15T12:00:00Z');

test('abre inmediatamente un curso publicado', () => {
  const access = courseReleaseAccess({ id: 'c1', status: 'published', releaseType: 'immediate' }, [], {}, NOW);
  assert.equal(access.allowed, true);
});

test('respeta fecha fija de publicación', () => {
  const locked = courseReleaseAccess({ status: 'published', releaseType: 'scheduled', unlockDate: '2026-08-20' }, [], {}, NOW);
  const open = courseReleaseAccess({ status: 'published', releaseType: 'scheduled', unlockDate: '2026-08-01' }, [], {}, NOW);
  assert.equal(locked.allowed, false);
  assert.equal(open.allowed, true);
});

test('calcula goteo usando orden y alta de membresía', () => {
  const course = { id: 'c2', status: 'published', releaseType: 'drip', order: 2 };
  const user = { subscription: { subscribedAt: '2026-08-10T12:00:00Z' } };
  const access = courseReleaseAccess(course, [course], user, NOW, 15);
  assert.equal(access.allowed, false);
  assert.equal(access.daysLeft, 10);
});

test('no libera borradores aunque el usuario tenga acceso', () => {
  const access = courseReleaseAccess({ status: 'draft', releaseType: 'immediate' }, [], {}, NOW);
  assert.equal(access.allowed, false);
  assert.equal(access.reason, 'course_not_published');
});

test('acredita tiempo real y no saltos grandes', () => {
  const state = advancePlaybackState({ watchedSeconds: 10, lastPositionSeconds: 10, lastSeenAt: NOW - 10000 }, {
    positionSeconds: 500,
    durationSeconds: 1000,
    event: 'seeked'
  }, NOW);
  assert.equal(state.watchedSeconds, 35);
  assert.equal(state.completed, false);
});

test('completa al acreditar al menos 85 por ciento', () => {
  const state = advancePlaybackState({ watchedSeconds: 84, lastPositionSeconds: 84, lastSeenAt: NOW - 1000 }, {
    positionSeconds: 90,
    durationSeconds: 100,
    event: 'timeupdate'
  }, NOW);
  assert.equal(state.completed, true);
});

test('exige completar la clase anterior para avanzar', () => {
  const course = { lessons: [{ id: 'l1', isPreview: true }, { id: 'l2' }, { id: 'l3' }] };
  assert.equal(isLessonSequenceUnlocked(course, course.lessons[1], [], false), false);
  assert.equal(isLessonSequenceUnlocked(course, course.lessons[1], ['l1'], false), true);
  assert.equal(isLessonSequenceUnlocked(course, course.lessons[2], ['l1'], false), false);
  assert.equal(isLessonSequenceUnlocked(course, course.lessons[2], ['l2'], false), true);
});

test('permite la vista previa y el acceso administrativo sin prerrequisitos', () => {
  const course = { lessons: [{ id: 'l1', isPreview: true }, { id: 'l2' }] };
  assert.equal(isLessonSequenceUnlocked(course, course.lessons[0], [], false), true);
  assert.equal(isLessonSequenceUnlocked(course, course.lessons[1], [], true), true);
});
