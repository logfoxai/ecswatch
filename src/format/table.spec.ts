import {test} from 'kizu';
import {visibleLen, trunc} from './table.js';

test('visibleLen counts plain characters', (assert) => {

    assert.equal(visibleLen('hello'), 5);
    assert.equal(visibleLen(''), 0);

});

test('visibleLen ignores ANSI SGR escapes', (assert) => {

    assert.equal(visibleLen('\x1b[31mhello\x1b[39m'), 5);
    assert.equal(visibleLen('\x1b[1m\x1b[32mok\x1b[39m\x1b[22m'), 2);

});

test('trunc leaves short strings untouched', (assert) => {

    assert.equal(trunc('hello', 10), 'hello');
    assert.equal(trunc('hello', 5), 'hello');

});

test('trunc adds an ellipsis when over width', (assert) => {

    assert.equal(trunc('hello world', 5), 'hell…');
    assert.equal(trunc('abcdef', 3), 'ab…');

});

test('trunc handles tiny widths without an ellipsis', (assert) => {

    assert.equal(trunc('hello', 1), 'h');
    assert.equal(trunc('hello', 0), '');

});
