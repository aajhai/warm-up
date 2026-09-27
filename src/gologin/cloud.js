const CLOUD_HOST = "cloudbrowser.gologin.com";
const API_HOST = "api.gologin.com";

function profilePath(profileId) {
  if (!/^[A-Za-z0-9_-]+$/.test(profileId || "")) throw new Error("A valid GoLogin profile ID is required.");
  return profileId;
}

export class CloudProfileLauncher {
  constructor({ token, fetchImpl = fetch } = {}) {
    this.token = token;
    this.fetch = fetchImpl;
    this.profileId = null;
  }

  connectionUrl(profileId, protocol = "wss:") {
    const url = new URL(`${protocol}//${CLOUD_HOST}/connect`);
    url.searchParams.set("token", this.token);
    url.searchParams.set("profile", profilePath(profileId));
    return url.toString();
  }

  async start(profileId) {
    this.profileId = profilePath(profileId);
    const response = await this.fetch(this.connectionUrl(profileId, "https:"), {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });
    await response.body?.cancel().catch(() => {});
    if (!response.ok) {
      const reason = response.headers.get("x-error-reason") || response.statusText || `HTTP ${response.status}`;
      throw new Error(`Failed to start GoLogin Cloud Browser: ${reason}`);
    }
    return this.connectionUrl(profileId);
  }

  async stop() {
    if (!this.profileId) return;
    const profileId = this.profileId;
    const response = await this.fetch(`https://${API_HOST}/browser/${profilePath(profileId)}/web`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${this.token}` },
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok && response.status !== 404) {
      const reason = response.headers.get("x-error-reason") || response.statusText || `HTTP ${response.status}`;
      const error = new Error(`Failed to stop GoLogin Cloud Browser: ${reason}`);
      error.retainBrowserLock = true;
      throw error;
    }
    this.profileId = null;
  }
}

export async function stopCloudProfile(profileId, { token, fetchImpl = fetch } = {}) {
  const launcher = new CloudProfileLauncher({ token, fetchImpl });
  launcher.profileId = profilePath(profileId);
  await launcher.stop();
}
