export function recordCancellation(result, signal) {
  if (signal.aborted) {
    result.aborted = true;
    result.reason ||= signal.reason?.message || "Session interrupted";
  }
  return result;
}
