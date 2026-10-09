import test from 'node:test';
import assert from 'node:assert/strict';
import { parseManifest } from '../src/media/mpd.ts';

const URL = 'https://cdn.example.test/video/manifest.mpd';

function mpd(duration: string, periods: string): string {
  return `<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="${duration}">${periods}</MPD>`;
}

const videoSet = (template: string) => `<AdaptationSet contentType="video">${template}<Representation id="v" bandwidth="1000" height="720"/></AdaptationSet>`;

test('a negative SegmentTimeline repeat runs until the end of the Period', () => {
  const manifest = parseManifest(mpd('PT60S', `<Period>${videoSet(
    '<SegmentTemplate timescale="1000" media="$Number$.m4s"><SegmentTimeline><S t="0" d="2000" r="-1"/></SegmentTimeline></SegmentTemplate>',
  )}</Period>`), URL);
  const video = manifest.periods[0]!.representations[0]!;
  assert.equal(video.mediaSegments.length, 30);
  assert.equal(video.durationSeconds, 60);
});

test('Periods with only a start last until the next one starts', () => {
  const template = '<SegmentTemplate timescale="1" duration="2" media="$Number$.m4s"/>';
  const manifest = parseManifest(mpd('PT60S', `<Period start="PT0S">${videoSet(template)}</Period><Period start="PT20S">${videoSet(template)}</Period>`), URL);
  assert.deepEqual(manifest.periods.map(period => period.representations[0]!.mediaSegments.length), [10, 20]);
});

test('durations with a date part are understood', () => {
  const manifest = parseManifest(mpd('P0Y0M0DT0H1M0.000S', `<Period>${videoSet('<SegmentTemplate timescale="1" duration="6" media="$Number$.m4s"/>')}</Period>`), URL);
  assert.equal(manifest.periods[0]!.representations[0]!.mediaSegments.length, 10);
});

test('SegmentTemplate attributes are inherited from the Period down to the Representation', () => {
  const manifest = parseManifest(mpd('PT6S', `<Period><SegmentTemplate timescale="1000" media="$RepresentationID$/$Time$.m4s" initialization="$RepresentationID$/init.mp4"/>
    <AdaptationSet contentType="video"><Representation id="v" bandwidth="1000">
      <SegmentTemplate><SegmentTimeline><S t="0" d="3000" r="1"/></SegmentTimeline></SegmentTemplate>
    </Representation></AdaptationSet></Period>`), URL);
  const video = manifest.periods[0]!.representations[0]!;
  assert.equal(video.initSegment?.url, 'https://cdn.example.test/video/v/init.mp4');
  assert.deepEqual(video.mediaSegments.map(segment => segment.url), [
    'https://cdn.example.test/video/v/0.m4s', 'https://cdn.example.test/video/v/3000.m4s',
  ]);
});
