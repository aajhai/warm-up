import { randomFloat, randomInt } from "./util/random.js";

function envBool(name, fallback) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

const argv = process.argv.slice(2);
const cliForce = argv.includes("--force") || argv.includes("--test");

// `schedule`, and every worker the service spawns (they carry --window or the scheduled
// marker), never run a verification session, whatever VERIFY_WARMUP says.
export function resolveVerifyWarmup(args = argv, env = process.env) {
  const on = (value) => value != null && ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
  const requested = on(env.VERIFY_WARMUP) || args.includes("--verify-warmup");
  const scheduled = args[0] === "schedule" || args.includes("--window") || on(env.WARMUP_SCHEDULED_WORKER);
  return { verifyWarmup: requested && !scheduled, ignored: requested && scheduled };
}
const verify = resolveVerifyWarmup();

export const config = {
  profileName: process.env.GL_PROFILE_NAME || process.env.GOLOGIN_PROFILE_NAME || "Kunal Mittal",
  profileId: process.env.GL_PROFILE_ID || process.env.GOLOGIN_PROFILE_ID || "",
  gologinToken: process.env.GL_API_TOKEN || process.env.GOLOGIN_API_TOKEN || process.env.GL_TOKEN || "",
  browserMode: (process.env.GOLOGIN_BROWSER_MODE || "cloud").toLowerCase(),
  likesEnabled: envBool("LIKES_ENABLED", true),
  stopProfileAfterSession: envBool("STOP_PROFILE_AFTER_SESSION", true),
  allowBlockedDay: envBool("ALLOW_BLOCKED_DAY", false) || argv.includes("--allow-blocked-day"),
  testRun: envBool("TEST_RUN", false) || cliForce,
  connectionTrial: argv.includes("--connection-trial"),
  // VERIFY_WARMUP=1 (or --verify-warmup) is for one operator verification session only.
  // It keeps every cap and safety check. It does not open profile or company pages and does
  // not send connection requests from anywhere except My Network. Only a one-shot `once`
  // honors it; see resolveVerifyWarmup.
  verifyWarmup: verify.verifyWarmup,
  verifyWarmupIgnored: verify.ignored,
  feedUrl: "https://www.linkedin.com/feed/",
  timezone: "Asia/Kolkata",
  sessionMinutes: { min: 10, max: 20 },
  dailySessionLimit: 4,
  dailyFailureLimit: 3,
  // Infrastructure failures (CDP/GoLogin) only skip this profile for the rest of the IST day.
  dailyInfraFailureLimit: 6,
  likeRate: { min: 0.02, max: 0.05 },
  likeCapPerSession: 3,
  dailyLikeBudget: 6,
  connectionsEnabled: envBool("CONNECTIONS_ENABLED", false),
  // Open risk: acceptance of sent invitations is not tracked, so a growing pile of
  // pending-without-acceptance invites is not visible to these caps. Do not raise them
  // until acceptance is measured.
  connectionWeeklyRanges: [[30, 50], [50, 70], [70, 80], [80, 100]],
  connectionWeekReset: "Monday 00:00 UTC",
  // Grow invites per session: [count, cumulative probability]. Zero is the most common draw.
  // Eight is the ceiling. The tail thins out so a session rarely sends the maximum.
  growInviteOdds: [[0, 0.28], [1, 0.46], [2, 0.60], [3, 0.72], [4, 0.82], [5, 0.90], [6, 0.95], [7, 0.98], [8, 1]],
  growInviteHardCap: 8,
  growSkipCardChance: 0.55,
  // After the session's last invite, stay on LinkedIn this long before the browser closes.
  postInviteDwellMs: { min: 60_000, max: 180_000 },
  // Follow is allowed only for person rows in the home-feed "Recommended for you"
  // module and person Suggested card headers. It never uses the connection budget.
  followsEnabled: envBool("FOLLOWS_ENABLED", true),
  follow: {
    sessionCapOdds: [[0, 0.72], [1, 0.95], [2, 1]],
    hardCapPerSession: 2,
    dailyBudget: 3,
    recommendedSkipChance: 0.6,
    pickChance: 0.3,
  },
  forbidden: ["comment", "message", "dm", "repost", "share"],
};

export function sampleFollowCap(roll = Math.random()) {
  if (!config.followsEnabled) return 0;
  const hit = config.follow.sessionCapOdds.find(([, upTo]) => roll < upTo);
  return Math.min(hit ? hit[0] : 0, config.follow.hardCapPerSession);
}

function fromOdds(odds, roll) {
  const hit = odds.find(([, upTo]) => roll < upTo);
  return hit ? hit[0] : 0;
}

export function sampleGrowInvites(roll = Math.random()) {
  return Math.min(fromOdds(config.growInviteOdds, roll), config.growInviteHardCap);
}

// Feed first. My Network runs only after that, and only when this session drew invitations.
// Profile pages, company pages, and search are not part of the session.
export function sampleFlow(rng = Math.random) {
  const inviteCount = sampleGrowInvites(rng());
  return {
    order: inviteCount > 0 ? ["feed", "grow"] : ["feed"],
    search: false,
    searchCompany: false,
    searchConnect: false,
    inviteCount,
    feedVisits: 0,
    growVisits: 0,
  };
}

function envSessionMinutes(name) {
  const value = process.env[name];
  if (value == null || value === "") return null;
  const parts = value.split(",").map((part) => Number.parseInt(part.trim(), 10));
  if (parts.length !== 2 || parts.some((n) => !Number.isInteger(n) || n < 1 || n > 20) || parts[0] > parts[1]) {
    throw new Error(`${name} must be two integers min,max between 1 and 20.`);
  }
  return { min: parts[0], max: parts[1] };
}

// TEST_SESSION_MINUTES applies only to test runs; SESSION_MINUTES overrides production length.
export function resolveSessionMinutes() {
  return (config.testRun && envSessionMinutes("TEST_SESSION_MINUTES"))
    || envSessionMinutes("SESSION_MINUTES")
    || config.sessionMinutes;
}

export function sampleSessionPlan() {
  const minutes = resolveSessionMinutes();
  return {
    sessionMs: randomInt(minutes.min * 60_000, minutes.max * 60_000),
    likeRate: randomFloat(config.likeRate.min, config.likeRate.max),
    likeCap: config.likeCapPerSession,
    skipFirstPosts: randomInt(3, 6),
    warmupMs: randomInt(70_000, 110_000),
    windDownMs: randomInt(35_000, 55_000),
    minMsBetweenLikes: randomInt(95_000, 190_000),
    settleMs: randomInt(3500, 9000),
    glanceNotifications: Math.random() < 0.32,
    reverseScrollChance: 0.05,
    expandRate: randomFloat(0.30, 0.40),
    idleChance: randomFloat(0.05, 0.12),
    postViewChance: randomFloat(0.28, 0.42),
    videoWatchChance: randomFloat(0.45, 0.7),
    videoWatchCap: randomInt(1, 2),
    followCap: sampleFollowCap(),
    followRecommended: Math.random() >= config.follow.recommendedSkipChance,
    minMsBetweenFollows: randomInt(120_000, 300_000),
    ...sampleFlow(),
  };
}
