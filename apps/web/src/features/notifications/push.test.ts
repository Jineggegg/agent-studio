import type { NotificationSettings } from '@agent-studio/protocol';
import { describe, expect, it } from 'vitest';
import { type BrowserPush, type DeviceFacts, type ServerFacts, applicationServerKey, decidePushState, isIosDevice, pushActionFor, sameKey } from './push';
import { isRegistered } from './state';

const desktop: BrowserPush = { api: true, secure: true, ios: false, standalone: false, permission: 'default' };
const worker: DeviceFacts = { worker: true, subscribed: false };
const subscribed: DeviceFacts = { worker: true, subscribed: true };
const known: ServerFacts = { registered: true, enabled: true };

describe('the device push state', () => {
  it('asks an iPhone or iPad outside the installed app to add it to the home screen first — whatever else is true', () => {
    expect(decidePushState({ ...desktop, ios: true, api: false }, worker, null)).toEqual({ kind: 'needs-install' });
    expect(decidePushState({ ...desktop, ios: true, permission: 'granted' }, subscribed, known)).toEqual({ kind: 'needs-install' });
    // Installed, on an iOS version with push: the ordinary flow.
    expect(decidePushState({ ...desktop, ios: true, standalone: true }, worker, null)).toEqual({ kind: 'not-asked' });
    // Installed on an iOS version without push.
    expect(decidePushState({ ...desktop, ios: true, standalone: true, api: false }, worker, null)).toEqual({ kind: 'unsupported', reason: 'no-api' });
  });

  it('tells apart a browser without push, a plain-http address and a page without its worker', () => {
    expect(decidePushState({ ...desktop, api: false }, worker, null)).toEqual({ kind: 'unsupported', reason: 'no-api' });
    expect(decidePushState({ ...desktop, secure: false }, worker, null)).toEqual({ kind: 'unsupported', reason: 'insecure' });
    expect(decidePushState(desktop, { worker: false, subscribed: false }, null)).toEqual({ kind: 'unsupported', reason: 'no-worker' });
  });

  it('says "blocked" when the permission was denied, even with a stale subscription and a device the server knows', () => {
    expect(decidePushState({ ...desktop, permission: 'denied' }, subscribed, known)).toEqual({ kind: 'denied' });
    expect(decidePushState({ ...desktop, permission: 'denied' }, null, null)).toEqual({ kind: 'denied' });
  });

  it('is "checking" while the browser or the server has not answered', () => {
    expect(decidePushState(desktop, null, null)).toEqual({ kind: 'checking' });
    expect(decidePushState(desktop, { worker: null, subscribed: false }, null)).toEqual({ kind: 'checking' });
    expect(decidePushState({ ...desktop, permission: 'granted' }, subscribed, null)).toEqual({ kind: 'checking' });
  });

  it('offers Enable before the permission was asked, and "Enable on this device" once it was given', () => {
    expect(decidePushState(desktop, worker, { registered: false, enabled: false })).toEqual({ kind: 'not-asked' });
    expect(decidePushState({ ...desktop, permission: 'granted' }, worker, { registered: false, enabled: true })).toEqual({ kind: 'not-subscribed' });
    // The browser holds a subscription the server does not know (signed out elsewhere): this device is not set up.
    expect(decidePushState({ ...desktop, permission: 'granted' }, subscribed, { registered: false, enabled: true })).toEqual({ kind: 'not-subscribed' });
  });

  it('is "on" only when this browser is registered and the account switch is on; otherwise "switched off"', () => {
    expect(decidePushState({ ...desktop, permission: 'granted' }, subscribed, known)).toEqual({ kind: 'on' });
    expect(decidePushState({ ...desktop, permission: 'granted' }, subscribed, { registered: true, enabled: false })).toEqual({ kind: 'channel-off' });
    // A permission that went back to "ask" means the browser shows nothing: not on.
    expect(decidePushState(desktop, subscribed, known)).toEqual({ kind: 'not-asked' });
  });

  it('offers at most one action per state', () => {
    expect(pushActionFor({ kind: 'not-asked' })).toBe('enable');
    expect(pushActionFor({ kind: 'not-subscribed' })).toBe('enable-device');
    expect(pushActionFor({ kind: 'channel-off' })).toBe('turn-on');
    expect(pushActionFor({ kind: 'on' })).toBe('test');
    for (const kind of ['denied', 'needs-install', 'checking'] as const) expect(pushActionFor({ kind })).toBeNull();
    expect(pushActionFor({ kind: 'unsupported', reason: 'insecure' })).toBeNull();
  });
});

describe('recognising the device', () => {
  it('knows an iPad that asks for desktop sites by its touch screen', () => {
    expect(isIosDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15', 5)).toBe(true);
    expect(isIosDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15', 5)).toBe(true);
    expect(isIosDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15', 0)).toBe(false);
    expect(isIosDevice('Mozilla/5.0 (Linux; Android 14) Chrome/126.0 Mobile Safari/537.36', 5)).toBe(false);
  });

  it('finds "this device" in the server’s list by its endpoint hash', () => {
    const hash = 'a'.repeat(16) + 'b'.repeat(48);
    const settings = (devices: { fingerprint: string; current: boolean }[]) =>
      ({ push: { devices: devices.map((device, index) => ({ id: String(index).padStart(26, '0'), label: 'x', createdAt: 0, lastDeliveredAt: null, ...device })) } }) as unknown as NotificationSettings;
    expect(isRegistered(settings([{ fingerprint: 'c'.repeat(16), current: true }]), hash)).toBe(true);
    expect(isRegistered(settings([{ fingerprint: 'a'.repeat(16), current: false }]), hash)).toBe(true);
    expect(isRegistered(settings([{ fingerprint: 'c'.repeat(16), current: false }]), hash)).toBe(false);
    // A missing fingerprint never matches everything.
    expect(isRegistered(settings([{ fingerprint: '', current: false }]), hash)).toBe(false);
    expect(isRegistered(undefined, hash)).toBe(false);
    expect(isRegistered(settings([{ fingerprint: 'a'.repeat(16), current: true }]), null)).toBe(false);
  });

  it('turns the server’s application key into bytes and compares a subscription’s key with it', () => {
    // 65 bytes: an uncompressed P-256 point, base64url without padding.
    const bytes = new Uint8Array(65).map((_, index) => (index * 7 + 4) % 256);
    bytes[0] = 4;
    const base64url = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect([...applicationServerKey(base64url)]).toEqual([...bytes]);
    expect(sameKey(bytes.buffer, base64url)).toBe(true);
    const other = bytes.slice();
    other[10] = (other[10]! + 1) % 256;
    expect(sameKey(other.buffer, base64url)).toBe(false);
    expect(sameKey(null, base64url)).toBe(false);
  });
});
