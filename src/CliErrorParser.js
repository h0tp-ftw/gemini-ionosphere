import { createError, ErrorType, ErrorCode } from "./errorHandler.js";

/**
 * Parses stderr output from the Gemini CLI to identify specific error types.
 */
export class CliErrorParser {
  /**
   * Extracts the retry delay (in ms) from Gemini CLI stderr output.
   * Supports multiple formats seen in production:
   *   1. Object dump:  retryDelayMs: 61253798.068514
   *   2. Human-readable: "quota will reset after 17h0m53s"
   *   3. Human-readable: "quota will reset after 53s"
   * @param {string} stderrText - Raw stderr text
   * @returns {number|null} Retry delay in milliseconds, or null if not parseable
   */
  static parseRetryDelay(stderrText) {
    if (!stderrText) return null;

    // Pattern 1: retryDelayMs property from TerminalQuotaError object dump
    const msMatch = stderrText.match(/retryDelayMs:\s*([\d.]+)/);
    if (msMatch) {
      const ms = parseFloat(msMatch[1]);
      if (ms > 0 && isFinite(ms)) return Math.ceil(ms);
    }

    // Pattern 2: Human-readable "quota will reset after XhYmZs" or "XmYs" or "Xs"
    const humanMatch = stderrText.match(/quota will reset after\s+(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/i);
    if (humanMatch) {
      const hours = parseInt(humanMatch[1] || '0', 10);
      const minutes = parseInt(humanMatch[2] || '0', 10);
      const seconds = parseInt(humanMatch[3] || '0', 10);
      const totalMs = ((hours * 3600) + (minutes * 60) + seconds) * 1000;
      if (totalMs > 0) return totalMs;
    }

    return null;
  }

  /**
   * Identifies if an error is fatal and should terminate the process.
   */
  parseStderr(stderrText, activeCallbacks) {
    if (!stderrText) return null;

    const isAuthError =
      (/(please log in|authenticate|not authenticated)/i.test(stderrText) ||
        (/\bauthorization\b/i.test(stderrText) && !/Authorization: '<<REDACTED/i.test(stderrText))) &&
      !/unauthorized tool call/i.test(stderrText) &&
      !/status: 500/i.test(stderrText);

    const isResourceError =
      /RESOURCE_EXHAUSTED|rateLimitExceeded|429|No capacity available|exhausted your capacity|TerminalQuotaError|quota will reset|MODEL_CAPACITY_EXHAUSTED|500|backendError|INTERNAL|Internal error encountered/i.test(
        stderrText,
      );

    const isPolicyError =
      /denied by policy|unauthorized tool call|not available to this agent/i.test(
        stderrText,
      );

    const isContextError =
      /too large|too long|context window|token limit|maximum tokens|request is too large/i.test(
        stderrText,
      );

    const isSafetyError =
      /safety settings|blocked|moderate|content filter|candidate was blocked/i.test(
        stderrText,
      );

    const isNotFound = /Tool "([^"]+)" not found/i.test(stderrText);

    const isModelError =
      /ModelNotFoundError|entity was not found/i.test(stderrText);

    if (isAuthError) {
      const errorMsg = `Fatal: CLI Auth Expired or Missing. Raw: ${stderrText}`;
      if (activeCallbacks.onError)
        activeCallbacks.onError(
          createError(errorMsg, ErrorType.AUTHENTICATION, ErrorCode.INVALID_API_KEY),
        );
      return { type: "FATAL", message: errorMsg };
    }

    if (isResourceError) {
      const errorMsg = `Gemini API Quota/Capacity Exhausted (429). Raw: ${stderrText}`;
      const retryAfterMs = CliErrorParser.parseRetryDelay(stderrText);
      if (retryAfterMs) {
        console.log(`[DEBUG] CliErrorParser: Matched isResourceError! retryAfterMs=${retryAfterMs} (${Math.round(retryAfterMs / 1000)}s). Error: ${errorMsg.substring(0, 120)}`);
      } else {
        console.log(`[DEBUG] CliErrorParser: Matched isResourceError! (no retry delay parsed). Error: ${errorMsg.substring(0, 120)}`);
      }
      // [IONOSPHERE] Proactive Termination: Even with SILENT_FALLBACK, we return FATAL 
      // so the GeminiController kills the stuck CLI process immediately. This allows 
      // the orchestrator (index.js) to trigger fallback/retry logic without waiting 
      // for the CLI's internal retry timeouts.
      if (activeCallbacks.onError && process.env.GEMINI_SILENT_FALLBACK !== "true")
        activeCallbacks.onError(
          createError(errorMsg, ErrorType.RATE_LIMIT, ErrorCode.RATE_LIMIT_EXCEEDED),
        );
      return { type: "FATAL", message: errorMsg, retryAfterMs };
    }

    if (isContextError) {
      const errorMsg = `Gemini API Context Window Exceeded. Raw: ${stderrText}`;
      if (activeCallbacks.onError)
        activeCallbacks.onError(
          createError(errorMsg, ErrorType.INVALID_REQUEST, ErrorCode.CONTEXT_LENGTH_EXCEEDED),
        );
      return { type: "FATAL", message: errorMsg };
    }

    if (isSafetyError) {
      const errorMsg = `Gemini API Content Filter / Safety Block. Raw: ${stderrText}`;
      if (activeCallbacks.onError)
        activeCallbacks.onError(
          createError(errorMsg, ErrorType.INVALID_REQUEST, ErrorCode.CONTENT_FILTER),
        );
      return { type: "FATAL", message: errorMsg };
    }

    if (isModelError) {
      const errorMsg = `Fatal: Model not found or inaccessible. Raw: ${stderrText}`;
      if (activeCallbacks.onError)
        activeCallbacks.onError(
          createError(errorMsg, ErrorType.INVALID_REQUEST, ErrorCode.MODEL_NOT_FOUND),
        );
      return { type: "FATAL", message: errorMsg };
    }

    if (isPolicyError) {
      const errorMsg = `Fatal: Tool use or action denied by policy. Raw: ${stderrText}`;
      if (activeCallbacks.onError)
        activeCallbacks.onError(
          createError(errorMsg, ErrorType.PERMISSION, ErrorCode.POLICY_DENIED),
        );
      return { type: "FATAL", message: errorMsg };
    }

    if (isNotFound) {
      const match = stderrText.match(/Tool "([^"]+)" not found/i);
      const toolName = match ? match[1] : "unknown";
      const errorMsg = `Fatal: Tool "${toolName}" not found. This environment does not support ${toolName}.`;
      
      if (activeCallbacks.onEvent) {
        activeCallbacks.onEvent({
          type: "tool_result",
          tool_name: toolName,
          result: errorMsg,
          is_error: true,
        });
      }
      return { type: "SOFT", message: errorMsg, toolName };
    }

    return null;
  }
}
