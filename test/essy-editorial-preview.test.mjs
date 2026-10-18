import test from 'node:test';
import assert from 'node:assert/strict';
import {assertEditorialPreviewAllowed} from '../src/essy-editorial-preview.mjs';

const state = () => ({series:'ESSY', status:'in_progress', prepare:{completed:true}, approvals:{english:{approved:true}, scenes:{approved:true}, package:{approved:false}}});
test('preview permitted with approved scenes and unapproved package', () => {
  const value = state();
  const before = structuredClone(value);
  assert.doesNotThrow(() => assertEditorialPreviewAllowed(value));
  assert.deepEqual(value, before);
});
test('preview blocked without approved scenes', () => {
  const value = state(); value.approvals.scenes.approved = false;
  assert.throws(() => assertEditorialPreviewAllowed(value), /approved scenes/);
});
test('preview blocked without approved English', () => {
  const value = state(); value.approvals.english.approved = false;
  assert.throws(() => assertEditorialPreviewAllowed(value), /approved English/);
});
