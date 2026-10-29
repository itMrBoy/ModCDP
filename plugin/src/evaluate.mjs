const limit = 256 * 1024;

// The supplied function is compiled by the browser, never by the Node runtime.
export async function evaluatePage(page, args) {
  if (!/^https?:\/\//i.test(page.url())) throw new Error("Scripts require a bound HTTP(S) page.");
  const expression = `async (argument) => {
    const fn = (${args.function}\n);
    if (typeof fn !== 'function') throw new Error('Provide a JavaScript function.');
    const result = await fn(argument);
    if (result === undefined) return {status:'completed', serialized:'null', result_was_undefined:true};
    const serialized = JSON.stringify(result, (_key, value) => {
      if (['undefined', 'function', 'symbol', 'bigint'].includes(typeof value) ||
          (typeof value === 'number' && !Number.isFinite(value)))
        throw new Error('Script result must contain only JSON-serializable values.');
      return value;
    });
    const bytes = new TextEncoder().encode(serialized).byteLength;
    return bytes > ${limit} ? {status:'result_too_large', size_bytes:bytes, limit_bytes:${limit}} :
      {status:'completed', serialized};
  }`;
  let timer;
  try {
    const response = await Promise.race([
      page.evaluate(`(${expression})(${JSON.stringify(args.args) ?? "undefined"})`),
      new Promise((resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              status: "timed_out",
              execution_may_continue: true,
              message: "Stopped waiting. Script effects may continue; do not automatically retry.",
            }),
          args.timeout_ms ?? 10000,
        );
      }),
    ]);
    if (!response || typeof response !== "object") throw new Error("Invalid script result envelope.");
    if (Buffer.byteLength(JSON.stringify(response)) > limit + 1024)
      throw new Error("Script result exceeds the 256 KiB JSON result limit.");
    if (response.status === "timed_out")
      return {
        status: "timed_out",
        execution_may_continue: true,
        message: "Stopped waiting. Script effects may continue; do not automatically retry.",
      };
    if (response.status === "result_too_large")
      return {
        status: "result_too_large",
        limit_bytes: limit,
        size_bytes: Number.isSafeInteger(response.size_bytes) ? response.size_bytes : null,
      };
    if (response.status !== "completed") throw new Error("Invalid script result status.");
    // Recheck at the transport boundary even if supplied code changes the wrapper's control flow.
    if (typeof response.serialized !== "string" || Buffer.byteLength(response.serialized) > limit)
      throw new Error("Script result exceeds the 256 KiB JSON result limit.");
    return {
      status: "completed",
      result: JSON.parse(response.serialized),
      ...(response.result_was_undefined ? { result_was_undefined: true } : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}
