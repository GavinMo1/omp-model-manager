import { test, expect } from 'bun:test';
import { splitSelector, joinSelector } from './role-selectors.js';

test('model IDs containing colons remain intact through a role edit', () => {
  expect(splitSelector('local/cn:auto')).toEqual({ model: 'local/cn:auto', effort: '' });
  expect(splitSelector('local/cn:auto:high')).toEqual({ model: 'local/cn:auto', effort: 'high' });
  expect(joinSelector('local/cn:auto', 'high')).toBe('local/cn:auto:high');
  expect(splitSelector('local/model:high', ['local/model:high'])).toEqual({ model: 'local/model:high', effort: '' });
  expect(joinSelector('', 'high')).toBe('');
  expect(joinSelector('@default')).toBe('@default');
});
