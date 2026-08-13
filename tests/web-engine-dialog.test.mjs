import assert from "node:assert/strict";
import test from "node:test";

import {
  isDialogBackdropPoint,
  shouldDismissDialog,
} from "../docs/src/dialog-interaction.mjs";

const RECT = Object.freeze({ left: 100, right: 500, top: 80, bottom: 600 });

test("only points on the backdrop outside the dialog surface count as dismissals", () => {
  for (const [clientX, clientY] of [[99, 300], [501, 300], [300, 79], [300, 601]]) {
    assert.equal(isDialogBackdropPoint({ targetIsDialog: true, clientX, clientY, rect: RECT }), true);
  }
  for (const [clientX, clientY] of [[100, 80], [500, 600], [300, 300]]) {
    assert.equal(isDialogBackdropPoint({ targetIsDialog: true, clientX, clientY, rect: RECT }), false);
  }
  assert.equal(isDialogBackdropPoint({ targetIsDialog: false, clientX: 99, clientY: 300, rect: RECT }), false);
  assert.equal(isDialogBackdropPoint({ targetIsDialog: true, clientX: NaN, clientY: 300, rect: RECT }), false);
});

test("backdrop close requires the gesture to start and end outside and never runs while busy", () => {
  assert.equal(shouldDismissDialog({ pointerStartedOnBackdrop: true, pointerEndedOnBackdrop: true }), true);
  assert.equal(shouldDismissDialog({ busy: true, pointerStartedOnBackdrop: true, pointerEndedOnBackdrop: true }), false);
  assert.equal(shouldDismissDialog({ pointerStartedOnBackdrop: false, pointerEndedOnBackdrop: true }), false);
  assert.equal(shouldDismissDialog({ pointerStartedOnBackdrop: true, pointerEndedOnBackdrop: false }), false);
});
