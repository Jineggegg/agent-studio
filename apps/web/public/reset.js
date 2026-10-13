/*
 * Recovery: removes every cached file and the offline worker for this origin.
 * A separate classic script because the Content-Security-Policy allows no inline script.
 */
(function () {
  'use strict';
  var jobs = [];
  try {
    if ('caches' in window) {
      jobs.push(
        caches.keys().then(function (names) {
          return Promise.all(
            names.map(function (name) {
              return caches.delete(name);
            }),
          );
        }),
      );
    }
    if ('serviceWorker' in navigator) {
      jobs.push(
        navigator.serviceWorker.getRegistrations().then(function (registrations) {
          return Promise.all(
            registrations.map(function (registration) {
              return registration.unregister();
            }),
          );
        }),
      );
    }
  } catch (_error) {
    document.body.setAttribute('data-state', 'failed');
    return;
  }
  Promise.all(jobs).then(
    function () {
      document.body.setAttribute('data-state', 'done');
    },
    function () {
      document.body.setAttribute('data-state', 'failed');
    },
  );
})();
