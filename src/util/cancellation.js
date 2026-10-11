import { isOperatorStop } from "./failures.js";

export function recordCancellation(result, signal) {
  if (signal.aborted) {
    result.aborted = true;
    result.failureKind = isOperatorStop(signal.reason) ? "operator" : "infra";
    result.reason ||= signal.reason?.message || "Session interrupted";
  }
  return result;
}
