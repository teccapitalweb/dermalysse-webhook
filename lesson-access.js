'use strict';

const { membershipAccess } = require('./access-policy');
const { courseReleaseAccess } = require('./course-policy');
const { isFreeLesson } = require('./initial-course-policy');

function lessonAccess(userData, course, lesson, options = {}) {
  const isAdmin = options.isAdmin === true;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const releaseAccess = courseReleaseAccess(course, options.catalog || [], userData, now);
  const result = { isAdmin, userData, releaseAccess, progressAllowed: false, freeLesson: false };
  if (isAdmin) return { ...result, allowed: true, progressAllowed: true };
  if (!course || !lesson || !(course.lessons || []).some(item => item.id && item.id === lesson.id)) {
    return { ...result, allowed: false, reason: 'lesson_not_found' };
  }
  // Ignore legacy isPreview flags, including flags supplied by old admin catalogs.
  if (isFreeLesson(course, lesson)) {
    const publicAccess = courseReleaseAccess({ ...course, releaseType: course.releaseType === 'drip' ? 'immediate' : course.releaseType }, options.catalog || [], userData, now);
    return { ...result, allowed: publicAccess.allowed, reason: publicAccess.reason, freeLesson: publicAccess.allowed, progressAllowed: publicAccess.allowed };
  }
  if (!membershipAccess(userData, now).allowed) return { ...result, allowed: false, reason: 'membership_required' };
  return { ...result, allowed: releaseAccess.allowed, reason: releaseAccess.reason, progressAllowed: releaseAccess.allowed };
}

module.exports = { lessonAccess };
