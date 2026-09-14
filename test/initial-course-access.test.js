'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { lessonAccess } = require('../lesson-access');
const { COURSE_ID, isFreeLesson, orderCatalog } = require('../initial-course-policy');
const { isLessonSequenceUnlocked } = require('../course-policy');
const NOW = Date.parse('2026-09-14T12:00:00Z');
const paid = { subscription: { status: 'active', currentPeriodEnd: '2026-10-14T12:00:00Z' } };
const makeCourse = (count, id = COURSE_ID) => ({ id, status: 'published', order: 1, lessons: Array.from({ length: count }, (_, i) => ({ id: 'lesson-' + (i + 1), isPreview: true })) });

for (const count of [0, 1, 2, 8]) {
  test(`curso inicial de ${count} clases: exactamente ${Math.max(0, count - 1)} gratuitas`, () => {
    const course = makeCourse(count);
    assert.equal(course.lessons.filter(lesson => isFreeLesson(course, lesson)).length, Math.max(0, count - 1));
    course.lessons.forEach((lesson, i) => {
      const access = lessonAccess({}, course, lesson, { now: NOW });
      assert.equal(access.allowed, i < count - 1);
      assert.equal(access.progressAllowed, i < count - 1);
    });
    assert.equal(isFreeLesson(course, { id: 'unknown', isPreview: true }), false);
  });
}

test('ninguna clase de otros cursos se libera aunque tengan flags preview antiguos', () => {
  const course = makeCourse(8, 'other-course');
  for (const lesson of course.lessons) {
    assert.equal(lessonAccess({}, course, lesson, { now: NOW }).allowed, false);
  }
  assert.equal(isLessonSequenceUnlocked(course, course.lessons[1], [], false), false);
});

test('conserva pago, cortesía y administración; membresía vencida solo recibe tramo gratis', () => {
  const intro = makeCourse(8);
  const other = makeCourse(2, 'other');
  const courtesy = { vigenciaHasta: '2026-10-14T12:00:00Z' };
  for (const user of [paid, courtesy]) {
    for (const course of [intro, other]) for (const lesson of course.lessons) assert.equal(lessonAccess(user, course, lesson, { now: NOW }).allowed, true);
  }
  assert.equal(lessonAccess({}, other, other.lessons[1], { isAdmin: true, now: NOW }).allowed, true);
  const expired = { subscription: { status: 'active', currentPeriodEnd: '2026-09-01T12:00:00Z' } };
  assert.equal(lessonAccess(expired, intro, intro.lessons[0], { now: NOW }).allowed, true);
  assert.equal(lessonAccess(expired, intro, intro.lessons[7], { now: NOW }).allowed, false);
});

test('curso inicial estable aunque el catálogo se filtre o cambie de orden', () => {
  const intro = makeCourse(2);
  const other = makeCourse(8, 'other');
  other.order = -100;
  assert.equal(orderCatalog([other, intro])[0].id, COURSE_ID);
  assert.equal(isFreeLesson(orderCatalog([other])[0], other.lessons[0]), false);
});

test('el tramo gratis respeta publicación y fecha, y el pago conserva el goteo', () => {
  const course = makeCourse(2);
  course.status = 'draft';
  assert.equal(lessonAccess({}, course, course.lessons[0], { now: NOW }).allowed, false);
  course.status = 'published'; course.releaseType = 'scheduled'; course.unlockDate = '2026-10-01';
  assert.equal(lessonAccess({}, course, course.lessons[0], { now: NOW }).allowed, false);
  course.releaseType = 'drip'; course.order = 2;
  assert.equal(lessonAccess({}, course, course.lessons[0], { now: NOW }).allowed, true);
  assert.equal(lessonAccess(paid, course, course.lessons[1], { now: NOW }).allowed, false);
});

test('el catálogo entregado tiene flags coherentes, última siempre premium', () => {
  const catalog = require('../data/dermalysse-courses.json');
  assert.equal(catalog[0].id, COURSE_ID);
  for (const course of catalog) for (const lesson of course.lessons) assert.equal(lesson.isPreview, isFreeLesson(course, lesson));
});

test('ambos endpoints de reproducción usan autorización central; progreso gratuito se acredita', () => {
  const source = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
  for (const route of ["'/api/bunny/embed-token'", "'/bunny/playback'"]) {
    const start = source.indexOf('app.post(' + route);
    const body = source.slice(start, source.indexOf('\napp.', start + 1));
    assert.match(body, /await authorizeLesson\(/);
    assert.match(body, /if \(!authorization.allowed\)/);
    assert.match(body, /preview: authorization.freeLesson === true/);
  }
  const intro = makeCourse(8);
  assert.equal(lessonAccess({}, intro, intro.lessons[6]).progressAllowed, true);
});
