// Contract: GoLogin's Local REST API, served by the desktop app on this Mac.
// https://www.postman.com/gologinapp/gologin/folder/dvcdgnu/local-rest-api
function annotate(error, message, retainBrowserLock) {
  const wrapped = new Error(message, { cause: error });
  wrapped.retainBrowserLock = retainBrowserLock;
  return wrapped;
}

export function responseSnippet(text, token) {
  let snippet = String(text ?? "").slice(0, 2000).replace(/\s+/g, " ").trim();
  if (token) snippet = snippet.split(token).join("[redacted]");
  snippet = snippet
    .replace(/(authorization["']?\s*[:=]\s*["']?)(?:bearer\s+)?[^\s"',;}]+/gi, "$1[redacted]")
    .replace(/\bbearer\s+[^\s"',;}]+/gi, "Bearer [redacted]")
    .replace(/((?:access_|api_|auth_|refresh_)?token["']?\s*[:=]\s*["']?)[^\s"',;&}]+/gi, "$1[redacted]")
    .replace(/\beyJ[\w-]+\.[\w-]+(?:\.[\w-]+)?/g, "[redacted]")
    .replace(/\b[A-Za-z0-9_\-+/]{32,}={0,2}/g, "[redacted]");
  return snippet.slice(0, 200);
}

export class LocalProfileLauncher {
  constructor({ token, fetchImpl = fetch, now = Date.now, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
    this.token = token;
    this.fetch = fetchImpl;
    this.profileId = null;
    this.wsUrl = null;
    this.now = now;
    this.pause = pause;
  }

  async request(operation, body, timeoutMs) {
    const response = await this.fetch(`http://127.0.0.1:36912/browser/${operation}-profile`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let json;
    try { json = text ? JSON.parse(text) : {}; }
    catch {
      throw new Error(`GoLogin local ${operation} returned an invalid response (HTTP ${response.status}): ${JSON.stringify(responseSnippet(text, this.token))}.`);
    }
    if (!response.ok || json.status === "error" || json.status === "failed") {
      throw new Error(`GoLogin local ${operation} failed (HTTP ${response.status}): ${json.message || json.error || "request rejected"}`);
    }
    return json;
  }

  async discoverDebuggerUrl(timeoutMs = 90_000) {
    const { execFileSync } = await import("node:child_process");
    const deadline = this.now() + timeoutMs;
    while (this.now() < deadline) {
      let listing = "";
      try {
        listing = execFileSync("ps", ["-ax", "-o", "command="], { encoding: "utf8" });
      } catch {
        listing = "";
      }
      for (const line of listing.split("\n")) {
        if (this.profileId && !line.includes(`GoLogin/profiles/${this.profileId}`)) continue;
        if (!/Orbita-Browser\.app\/Contents\/MacOS\/Orbita/.test(line)) continue;
        const match = line.match(/--remote-debugging-port=(\d+)/);
        if (!match) continue;
        try {
          const response = await this.fetch(`http://127.0.0.1:${match[1]}/json/version`, { redirect: "error", signal: AbortSignal.timeout(1500) });
          if (!response.ok) continue;
          const json = await response.json();
          const wsUrl = json.webSocketDebuggerUrl;
          if (!wsUrl) continue;
          const url = new URL(wsUrl);
          if (url.protocol === "ws:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return wsUrl;
        } catch { /* not this port */ }
      }
      await this.pause(1500);
    }
    return null;
  }

  async start(profileId) {
    this.profileId = profileId;
    try {
      const started = await this.request("start", {
        profileId,
        sync: true,
        // Best-effort; desktop API may ignore unknown fields. Orbita binary is also wrapped.
        args: [
          "--disable-gpu",
          "--disable-gpu-compositing",
          "--disable-dev-shm-usage",
          "--disable-features=Vulkan",
          "--use-gl=swiftshader",
          "--enable-unsafe-swiftshader",
        ],
      }, 240_000);
      // GoLogin often returns success with an empty wsUrl while Orbita is still
      // binding the debugger. An empty string must not be passed to URL().
      if (started.wsUrl === "") {
        const discovered = await this.discoverDebuggerUrl(90_000);
        if (!discovered) throw new Error("GoLogin started without a local debugger endpoint.");
        this.wsUrl = discovered;
        return discovered;
      }
      const url = new URL(started.wsUrl);
      if (url.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password || !url.pathname.startsWith("/devtools/browser/")) {
        throw new Error("GoLogin returned a non-local or invalid browser endpoint.");
      }
      this.wsUrl = started.wsUrl;
      return started.wsUrl;
    } catch (error) {
      // A timeout/rejected response cannot establish whether the app started a browser.
      // Never retry Start or stop a potentially pre-existing manual session.
      const unavailable = error.cause?.code === "ECONNREFUSED";
      this.profileId = null;
      throw annotate(
        error,
        unavailable
          ? "GoLogin's local API is unavailable. Open GoLogin.app and retry."
          : `${error.message} Inspect this profile in GoLogin before releasing the browser lock.`,
        !unavailable,
      );
    }
  }

  async stop() {
    if (!this.profileId) return;
    try {
      await this.request("stop", { profileId: this.profileId }, 60_000);
      // The app responds 204 before killProfile finishes. Do not release our
      // browser lock until the owned debugging endpoint is no longer running.
      if (this.wsUrl) {
        const endpoint = new URL(this.wsUrl);
        endpoint.protocol = "http:";
        endpoint.pathname = "/json/version";
        const deadline = this.now() + 30_000;
        let closed = false;
        while (this.now() < deadline) {
          try {
            const response = await this.fetch(endpoint, { redirect: "error", signal: AbortSignal.timeout(2000) });
            if (response.ok) {
              const data = await response.json();
              if (data.webSocketDebuggerUrl && data.webSocketDebuggerUrl !== this.wsUrl) { closed = true; break; }
            }
          } catch (error) {
            if (error.cause?.code === "ECONNREFUSED") { closed = true; break; }
          }
          await this.pause(500);
        }
        if (!closed) throw new Error("GoLogin browser endpoint remained open after Stop.");
      }
      this.profileId = null;
      this.wsUrl = null;
    } catch (error) {
      throw annotate(
        error,
        `${error.message} Browser shutdown is unconfirmed; close it in GoLogin before releasing the browser lock.`,
        true,
      );
    }
  }
}
