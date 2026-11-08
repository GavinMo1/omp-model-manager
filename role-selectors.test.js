import { test, expect } from 'bun:test';
import { splitSelector, joinSelector, parseRoleSelectors } from './role-selectors.js';

test('model IDs containing colons remain intact through a role edit', () => {
  expect(splitSelector('local/cn:auto')).toEqual({ model: 'local/cn:auto', effort: '' });
  expect(splitSelector('local/cn:auto:high')).toEqual({ model: 'local/cn:auto', effort: 'high' });
  expect(joinSelector('local/cn:auto', 'high')).toBe('local/cn:auto:high');
  expect(splitSelector('local/model:high', ['local/model:high'])).toEqual({ model: 'local/model:high', effort: '' });
  expect(joinSelector('', 'high')).toBe('');
  expect(joinSelector('@default')).toBe('@default');
});

test('comma-separated selectors are parsed item by item', () => {
  expect(parseRoleSelectors('a/x, b/y:high , @default, *', ['a/x'])).toEqual([
    { raw: 'a/x', kind: 'model', model: 'a/x', effort: '' },
    { raw: 'b/y:high', kind: 'model', model: 'b/y:high', effort: '' },
    { raw: '@default', kind: 'alias', model: '@default', effort: '' },
    { raw: '*', kind: 'alias', model: '*', effort: '' },
  ]);
});

test('a suffix is only stripped when the base is a known model', () => {
  expect(parseRoleSelectors('p/cn:auto', ['p/cn:auto'])[0].model).toBe('p/cn:auto');
  expect(parseRoleSelectors('p/cn:auto:high', ['p/cn:auto'])[0]).toEqual({ raw: 'p/cn:auto:high', kind: 'model', model: 'p/cn:auto', effort: 'high' });
  expect(parseRoleSelectors('p/cn:auto', [])[0].model).toBe('p/cn:auto');
  expect(parseRoleSelectors('p/cn:auto:inherit', ['p/cn:auto'])[0].effort).toBe('inherit');
});
