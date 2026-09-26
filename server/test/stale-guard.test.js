'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRunGuard } = require('../../web/src/stale-guard');

test('response from the current run is accepted', () => {
  const g = createRunGuard();
  const token = g.beginRun();
  assert.equal(g.isCurrent(token), true);
});

test('a draft edit after the run started makes its response stale', () => {
  const g = createRunGuard();
  const token = g.beginRun();
  g.adoptView(token);
  assert.equal(g.bumpDraft(), true, 'first edit marks the displayed view stale');
  assert.equal(g.isCurrent(token), false);
  // A late old response must be rejected; editing again changes nothing more.
  assert.equal(g.bumpDraft(), false);
  assert.equal(g.viewStale(), true);
});

test('cancelling the run invalidates the in-flight response', () => {
  const g = createRunGuard();
  const token = g.beginRun();
  g.cancelRuns();
  assert.equal(g.isCurrent(token), false);
  assert.equal(g.hasView(), false);
});

test('a newer run supersedes responses from the older run', () => {
  const g = createRunGuard();
  const old = g.beginRun();
  const newest = g.beginRun();
  assert.equal(g.isCurrent(old), false);
  assert.equal(g.isCurrent(newest), true);
});

test('a fresh submit resets staleness for the view until another edit', () => {
  const g = createRunGuard();
  const first = g.beginRun();
  g.adoptView(first);
  g.bumpDraft();
  assert.equal(g.viewStale(), true);
  const second = g.beginRun();
  g.markViewFresh();
  g.adoptView(second);
  assert.equal(g.viewStale(), false);
  assert.equal(g.isCurrent(second), true);
  g.bumpDraft();
  assert.equal(g.isCurrent(second), false);
  assert.equal(g.viewStale(), true);
});
