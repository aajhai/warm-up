export function recordCancellation(result, signal) {
  if (signal.aborted) {
    result.aborted = true;
    result.failureKind = "infra";
    result.reason ||= signal.reason?.message || "Session interrupted";
  }
  return result;
}
