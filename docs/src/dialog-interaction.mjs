function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function isDialogBackdropPoint({ targetIsDialog, clientX, clientY, rect } = {}) {
  if (
    targetIsDialog !== true
    || !rect
    || ![clientX, clientY, rect.left, rect.right, rect.top, rect.bottom].every(finite)
  ) return false;
  return clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom;
}

export function shouldDismissDialog({ busy = false, pointerStartedOnBackdrop = false, pointerEndedOnBackdrop = false } = {}) {
  return busy !== true && pointerStartedOnBackdrop === true && pointerEndedOnBackdrop === true;
}

