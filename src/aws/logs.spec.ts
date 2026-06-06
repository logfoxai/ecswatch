import {test} from 'kizu';

import {lastLinesPerStream} from './logs.js';
import type {LogLine} from '../types.js';

function line(stream: string, t: number, message = 'x'): LogLine {

    return {stream, timestamp: new Date(t), message, severity: 'info'};

}

test('lastLinesPerStream keeps every stream even when one is chatty', (assert) => {

    // Mirrors a rollback: one surviving task spams healthchecks while a crashed
    // task emits a short traceback slightly earlier. A naive "newest N by time"
    // would return only the healthcheck stream and hide the crash.
    const chatty: LogLine[] = [];

    for (let i = 0; i < 100; i++) chatty.push(line('app/app/running', 10_000 + i, 'GET /health 200'));

    const crashed: LogLine[] = [];

    for (let i = 0; i < 5; i++) crashed.push(line('app/app/crashed', 9_000 + i, 'Traceback'));

    const selected = lastLinesPerStream([...chatty, ...crashed], 50);
    const streams = new Set(selected.map((l) => l.stream));

    assert.equal(streams.has('app/app/crashed'), true);
    assert.equal(streams.has('app/app/running'), true);
    assert.equal(selected.filter((l) => l.stream === 'app/app/crashed').length, 5);

});

test('lastLinesPerStream caps each stream to its newest perStream lines', (assert) => {

    const lines: LogLine[] = [];

    for (let i = 0; i < 10; i++) lines.push(line('s', 1_000 + i, `m${i}`));

    const selected = lastLinesPerStream(lines, 3);

    assert.equal(selected.map((l) => l.message), ['m7', 'm8', 'm9']);

});

test('lastLinesPerStream returns lines chronologically across streams', (assert) => {

    const mixed = [line('a', 3), line('b', 1), line('a', 4), line('b', 2)];
    const selected = lastLinesPerStream(mixed, 10);

    assert.equal(selected.map((l) => l.timestamp.getTime()), [1, 2, 3, 4]);

});

test('lastLinesPerStream returns empty for non-positive perStream', (assert) => {

    assert.equal(lastLinesPerStream([line('a', 1)], 0), []);

});
