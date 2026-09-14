(function (root, factory) {
  const policy = factory();
  if (typeof module === 'object' && module.exports) module.exports = policy;
  else root.DermalysseInitialCourse = policy;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // Stable identity: filtering/reordering the catalog must never give another course away.
  const COURSE_ID = 'course-uso-de-tecnologias-avanzadas-en-cosmiatria';

  function isInitialCourse(course) {
    return !!course && course.id === COURSE_ID;
  }

  function isFreeLesson(course, lesson) {
    if (!isInitialCourse(course) || !lesson || (course.status && course.status !== 'published')) return false;
    const lessons = Array.isArray(course.lessons) ? course.lessons : [];
    if (lessons.length < 2) return false;
    const id = String(lesson.contentId || lesson.id || '');
    if (!id) return false;
    const index = lessons.findIndex(item => item && String(item.contentId || item.id || '') === id);
    return index >= 0 && index < lessons.length - 1;
  }

  function orderCatalog(courses) {
    return (Array.isArray(courses) ? courses : []).slice().sort((a, b) => {
      if (isInitialCourse(a) !== isInitialCourse(b)) return isInitialCourse(a) ? -1 : 1;
      return (Number(a.order) || 0) - (Number(b.order) || 0);
    });
  }

  return { COURSE_ID, isInitialCourse, isFreeLesson, orderCatalog };
});
