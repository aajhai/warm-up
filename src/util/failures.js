const CDP_FAILURE = /Protocol error|Runtime\.callFunctionOn|Target closed|Session closed|Connection closed|browser\.pages probe timed out|Session exceeded its execution deadline|execution stalled|interrupted by operator|GoLogin|Orbita|debugger|Could not attach|fetch failed|timed? ?out/i;
const RECOVERABLE_POINTER_STALL = /CDP mouse (?:event|session attach) timed out/i;

export function isRecoverablePointerStall(error) {
  return Boolean(error && RECOVERABLE_POINTER_STALL.test(error.message || String(error)));
}

export function isInfrastructureFailure(error) {
  if (!error) return false;
  if (error.failureKind === "infra") return true;
  const message = error.message || String(error);
  // Pointer CDP stalls are recovered in-gesture; they must not abort the warm-up alone.
  if (isRecoverablePointerStall(error)) return false;
  return CDP_FAILURE.test(message);
}

export function infrastructureError(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.failureKind = "infra";
  return error;
}

export function failureKind(error) {
  return isInfrastructureFailure(error) ? "infra" : "scenario";
}
