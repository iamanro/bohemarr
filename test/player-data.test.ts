import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJsObject } from '../src/providers/nova-markiza-utils.ts';
import { bracketSubstring } from '../src/providers/common.ts';
import { evaluatePlayerScript } from '../src/providers/javascript.ts';
import { tracksToSources } from '../src/providers/nova-markiza-media.ts';

test('extensionless protected manifests cannot be downgraded to clear downloads', () => {
  const protectedTrack = { src: 'https://media.test/manifest?id=42', type: 'application/dash+xml', contentProtection: { token: 'test-license-token' } };
  const clearTrack = { src: 'https://media.test/clear.mp4', type: 'video/mp4' };
  const supported = tracksToSources([protectedTrack], 'https://tv.nova.cz/');
  assert.equal(supported[0]?.type, 'dash');
  assert.ok(supported[0]?.drm, 'protected source lost its license requirement');
  assert.deepEqual(tracksToSources([protectedTrack, clearTrack], undefined), [{ url: clearTrack.src, type: 'file' }]);
});

test('player configuration accepts literals but refuses executable expressions', () => {
  assert.deepEqual(parseJsObject("{streams: [{url: 'https://media.test/video.mpd',}],}"), {
    streams: [{ url: 'https://media.test/video.mpd' }],
  });
  assert.throws(() => parseJsObject('{ streams: (function () { return []; })() }'));
});

test('player transforms cannot access Node and have a bounded execution time', async () => {
  assert.equal(await evaluatePlayerScript("typeof process + ':' + typeof require + ':' + typeof fetch"), 'undefined:undefined:undefined');
  assert.equal(await evaluatePlayerScript("'abc'.split('').reverse().join('')"), 'cba');
  await assert.rejects(evaluatePlayerScript('while (true) {}'));
});

test('a bracketed block is cut out whole, even with brackets inside its strings', () => {
  assert.equal(bracketSubstring('var data = {"text":"Soud :-}","n":{"a":1}}; more', 0), '{"text":"Soud :-}","n":{"a":1}}');
  assert.equal(bracketSubstring('var playerVideos = [{"name":"HD ]"}];', 0, '[', ']'), '[{"name":"HD ]"}]');
  assert.equal(bracketSubstring('cut {"a": 1', 0), '');
});
