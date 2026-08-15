'use strict';

const DEFAULT_DRIP_DAYS = 15;
const COMPLETION_RATIO = 0.85;

function toMillis(value) {
  if (!value) return NaN;
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value === 'number') return value;
  return Date.parse(value);
}

function membershipStartedAt(userData) {
  const data = userData || {};
  const subscription = data.subscription || {};
  return [
    data.regaloDesde,
    subscription.subscribedAt,
    subscription.createdAt,
    subscription.updatedAt
  ].map(toMillis).find(Number.isFinite);
}

function courseReleaseAccess(course, catalog, userData, nowValue, dripDaysValue) {
  if (!course) return { allowed: false, reason: 'course_not_found' };
  if (course.status && course.status !== 'published') {
    return { allowed: false, reason: 'course_not_published' };
  }

  const releaseType = String(course.releaseType || 'immediate').toLowerCase();
  const now = Number.isFinite(nowValue) ? nowValue : Date.now();

  if (releaseType === 'scheduled') {
    const unlockAt = toMillis(course.unlockDate);
    if (!Number.isFinite(unlockAt)) return { allowed: false, reason: 'schedule_missing' };
    return {
      allowed: unlockAt <= now,
      reason: unlockAt <= now ? 'scheduled_open' : 'scheduled_locked',
      unlockAt
    };
  }

  if (releaseType === 'drip') {
    const courses = Array.isArray(catalog) ? catalog : [];
    const catalogIndex = Math.max(0, courses.findIndex(item => item && item.id === course.id));
    const order = Math.max(1, Number(course.order) || catalogIndex + 1);
    const dripDays = Math.max(1, Number(dripDaysValue) || DEFAULT_DRIP_DAYS);
    const startedAt = membershipStartedAt(userData);
    if (!Number.isFinite(startedAt)) return { allowed: false, reason: 'membership_start_missing' };
    const unlockAt = startedAt + ((order - 1) * dripDays * 86400000);
    return {
      allowed: unlockAt <= now,
      reason: unlockAt <= now ? 'drip_open' : 'drip_locked',
      unlockAt,
      daysLeft: Math.max(0, Math.ceil((unlockAt - now) / 86400000))
    };
  }

  return { allowed: true, reason: 'immediate' };
}

function isLessonSequenceUnlocked(course, lesson, completedLessonIds, isAdmin) {
  if (isAdmin || (lesson && lesson.isPreview)) return true;
  const lessons = course && Array.isArray(course.lessons) ? course.lessons : [];
  const lessonIndex = lessons.findIndex(item => String(item.id || '') === String((lesson && lesson.id) || ''));
  if (lessonIndex <= 0) return true;
  const completed = new Set(Array.isArray(completedLessonIds) ? completedLessonIds.map(String) : []);
  return completed.has(String(lessons[lessonIndex - 1].id || ''));
}

function advancePlaybackState(previousValue, inputValue, nowValue) {
  const previous = previousValue || {};
  const input = inputValue || {};
  const now = Number.isFinite(nowValue) ? nowValue : Date.now();
  const durationSeconds = Math.max(1, Number(input.durationSeconds) || Number(previous.durationSeconds) || 1);
  const positionSeconds = Math.min(durationSeconds, Math.max(0, Number(input.positionSeconds) || 0));
  const previousPosition = Math.max(0, Number(previous.lastPositionSeconds) || 0);
  const previousWatched = Math.max(0, Number(previous.watchedSeconds) || 0);
  const previousSeenAt = toMillis(previous.lastSeenAt);
  const elapsedSeconds = Number.isFinite(previousSeenAt)
    ? Math.max(0, Math.min(120, (now - previousSeenAt) / 1000))
    : 0;
  const forwardSeconds = Math.max(0, positionSeconds - previousPosition);
  // Permite reproducción hasta 2x y una pequeña tolerancia de red, pero no
  // acredita saltos grandes hechos con la barra de progreso.
  const creditedSeconds = Math.min(forwardSeconds, (elapsedSeconds * 2) + 5);
  const watchedSeconds = Math.min(durationSeconds, previousWatched + creditedSeconds);
  const ratio = watchedSeconds / durationSeconds;
  const completed = previous.completed === true || ratio >= COMPLETION_RATIO;

  return {
    durationSeconds,
    watchedSeconds: Math.round(watchedSeconds * 10) / 10,
    lastPositionSeconds: Math.round(positionSeconds * 10) / 10,
    lastSeenAt: now,
    completed,
    completionRatio: Math.round(ratio * 1000) / 1000,
    lastEvent: String(input.event || 'timeupdate')
  };
}

module.exports = {
  COMPLETION_RATIO,
  DEFAULT_DRIP_DAYS,
  advancePlaybackState,
  courseReleaseAccess,
  isLessonSequenceUnlocked,
  membershipStartedAt,
  toMillis
};
