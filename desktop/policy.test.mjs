import test from 'node:test';
import assert from 'node:assert/strict';
import { serverUrl, sameServer, externalLink, notificationPayload } from './policy.mjs';
test('desktop accepts HTTPS or exact loopback HTTP only', () => {
  for (const url of [
    'https://example.com',
    'http://localhost:7420',
    'http://127.0.0.1:7420',
    'http://[::1]:7420',
  ])
    assert.ok(serverUrl(url));
  for (const url of [
    'http://example.com',
    'http://192.168.1.2',
    'http://localhost.evil.test',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'https://user:password@example.com',
    'https://example.com?token=abc',
    'https://example.com/#secret',
  ])
    assert.throws(() => serverUrl(url));
});
test('navigation cannot cross the configured origin', () => {
  assert.equal(sameServer('https://example.com/workbench', 'https://example.com'), true);
  assert.equal(sameServer('https://example.com.evil.test', 'https://example.com'), false);
  assert.equal(sameServer('https://example.com:8443', 'https://example.com'), false);
  assert.equal(sameServer('file:///etc/passwd', 'https://example.com'), false);
  assert.equal(externalLink('javascript:alert(1)'), null);
});
test('notification payload cannot carry arbitrary structures or unbounded text', () => {
  assert.equal(notificationPayload({ title: {}, body: 'x' }), null);
  const result = notificationPayload({ title: 'a'.repeat(500), body: 'b'.repeat(900) });
  assert.equal(result.title.length, 120);
  assert.equal(result.body.length, 600);
});
