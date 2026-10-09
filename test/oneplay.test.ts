import test from 'node:test';
import assert from 'node:assert/strict';
import { pushedReply } from '../src/providers/oneplay-connection.ts';
import { at, successData } from '../src/providers/oneplay-protocol.ts';

test('a pushed error reply keeps its code where the busy and PIN checks read it', () => {
  const reply = pushedReply({
    command: 'content.play',
    response: { context: { requestId: 'r1' }, result: { status: 'Error', code: '4091', message: 'max. počet současných sledování' } },
  });
  assert.equal(reply?.requestId, 'r1');
  assert.equal(at(reply!.response.data, 'result.code'), '4091');

  const failed = pushedReply({ response: { context: { requestId: 'r2' }, result: { status: 'Error', code: '1000', message: 'Bad request' } } });
  assert.throws(() => successData(failed!.response), /Bad request/);

  const ok = pushedReply({ response: { context: { requestId: 'r3' }, result: { status: 'Ok' }, data: { media: 1 } } });
  assert.deepEqual(successData(ok!.response), { media: 1 });
});
