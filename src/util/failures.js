const CDP_FAILURE = /Protocol error|Runtime\.callFunctionOn|Target closed|Session closed|Connection closed|browser\.pages probe timed out|Session exceeded its execution deadline|execution stalled|made no progress|interrupted by operator|GoLogin|Orbita|debugger|Could not attach|fetch failed|timed? ?out|Working tab is not LinkedIn|Profile opened with no|chrome-error/i;
const RECOVERABLE_POINTER_STALL = /CDP mouse (?:event|session attach) timed out/i;
const OPERATOR_STOP = /interrupted by operator/i;
const NETWORK_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH", "ENETDOWN", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"]);

export function isRecoverablePointerStall(error) {
  return Boolean(error && RECOVERABLE_POINTER_STALL.test(error.message || String(error)));
}

export function isOperatorStop(error) {
  return Boolean(error && OPERATOR_STOP.test(error.message || String(error)));
}

// A request that never reached GoLogin (DNS, refused socket, network down). The GoLogin
// API answering with an HTTP error is not an outage.
export function isNetworkOutage(error) {
  for (let current = error, depth = 0; current && depth < 4; current = current.cause, depth += 1) {
    if (current.networkOutage) return true;
    if (NETWORK_CODES.has(current.code)) return true;
    if (/^fetch failed$/i.test(current.message || "")) return true;
    if (/GoLogin's local API is unavailable/i.test(current.message || "")) return true;
  }
  return false;
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
  if (isOperatorStop(error)) return "operator";
  return isInfrastructureFailure(error) ? "infra" : "scenario";
}
