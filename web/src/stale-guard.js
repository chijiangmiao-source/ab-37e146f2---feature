'use strict';

/**
 * Run / draft-generation guard for the review page (UMD: browser global +
 * Node `module.exports`, so the stale-response logic is unit-testable).
 *
 * A review response is only allowed to replace the on-screen conclusion when
 * it is still *current*: the run it belongs to is the latest run AND the
 * draft has not been edited since that run started.  Editing the draft or
 * cancelling a run invalidates every older response, which must then be
 * dropped silently rather than overwrite the current conclusion.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.LR1RunGuard = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createRunGuard() {
    let runSeq = 0;          // bumped on every submit and on cancel
    let draftGeneration = 0; // bumped on every draft edit
    let view = null;         // {runId, generation, stale} describing the screen

    return {
      // Begin a new review run; the returned token identifies its responses.
      beginRun() {
        runSeq += 1;
        return { runId: runSeq, generation: draftGeneration };
      },

      // Cancel any in-flight run: its later response must be discarded.
      cancelRuns() {
        runSeq += 1;
        view = null;
      },

      // A draft edit invalidates the conclusion currently on screen.
      // Returns true exactly when the displayed view newly becomes stale.
      bumpDraft() {
        draftGeneration += 1;
        if (view && !view.stale && view.generation !== draftGeneration) {
          view.stale = true;
          return true;
        }
        return false;
      },

      // Mark the (still displayed) previous view as fresh while a new run is
      // computing; a later draft edit re-stales it via bumpDraft().
      markViewFresh() {
        if (view) view.stale = false;
      },

      adoptView(token) {
        view = { runId: token.runId, generation: token.generation, stale: false };
      },
      clearView() {
        view = null;
      },

      // Core stale test used before rendering any fetched response.
      isCurrent(token) {
        return token.runId === runSeq && token.generation === draftGeneration;
      },

      hasView() {
        return view !== null;
      },
      viewStale() {
        return !!(view && view.stale);
      },
      get runId() {
        return runSeq;
      },
      get generation() {
        return draftGeneration;
      },
    };
  }

  return { createRunGuard };
});
