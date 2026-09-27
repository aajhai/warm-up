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
  // VERIFY_WARMUP=1 (or --verify-warmup) is for one operator verification session only. It
  // keeps every cap and safety check but forces the plan to include: feed, search with one
  // person profile read, a company page read, a Follow if a Recommended/Suggested button is
  // on screen, one exact profile Connect if the top card offers it, and at least one Grow
  // invite. Search runs first; if it misses, the first feed person profile supplies the
  // Connect attempt and a company link. Production sessions never set it and keep the random
  // plan from sampleFlow. Only a one-shot `once` honors it; see resolveVerifyWarmup.
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
  growInviteOdds: [[0, 0.4], [1, 0.62], [2, 0.8], [3, 0.92], [4, 1]],
  growInviteHardCap: 4,
  growSkipCardChance: 0.35,
  // Profile/company page views per session from the feed, home rail, and Grow. Search adds
  // its own result view on top, so a planned search never uses up these views.
  visitOdds: [[0, 0.18], [1, 0.6], [2, 0.88], [3, 1]],
  searchChance: 0.55,
  searchCompanyChance: 0.3,
  // Share of searches that may press an exact profile Connect (~1 in 5). Most searches
  // only read the profile.
  searchConnectChance: 0.2,
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

// Decides which surfaces this session touches and in what order. The feed always runs;
// search and Grow are optional and move around it so sessions do not share one script.
export function sampleFlow(rng = Math.random) {
  const search = rng() < config.searchChance;
  let rest = fromOdds(config.visitOdds, rng());
  const inviteCount = sampleGrowInvites(rng());
  const searchCompany = search && rng() < config.searchCompanyChance;
  let feedVisits = 0;
  let growVisits = 0;
  for (; rest > 0; rest -= 1) {
    if (rng() < 0.6) feedVisits += 1;
    else growVisits += 1;
  }
  const grow = inviteCount > 0 || growVisits > 0;
  const variants = [];
  if (search) {
    variants.push(["search", "feed", ...(grow ? ["grow"] : [])]);
    variants.push(["feed", "search", ...(grow ? ["grow"] : [])]);
    if (grow) variants.push(["feed", "grow", "search"]);
  } else {
    variants.push(["feed", ...(grow ? ["grow"] : [])]);
  }
  const order = variants[Math.min(variants.length - 1, Math.floor(rng() * variants.length))];
  return {
    order,
    search,
    searchCompany,
    searchConnect: search && rng() < config.searchConnectChance,
    inviteCount,
    feedVisits,
    growVisits,
  };
}

function testSessionMinutes() {
  if (!config.testRun) return null;
  const value = process.env.TEST_SESSION_MINUTES;
  if (value == null || value === "") return null;
  const parts = value.split(",").map((part) => Number.parseInt(part.trim(), 10));
  if (parts.length !== 2 || parts.some((n) => !Number.isInteger(n) || n < 1 || n > 20) || parts[0] > parts[1]) {
    throw new Error("TEST_SESSION_MINUTES must be two integers min,max between 1 and 20.");
  }
  return { min: parts[0], max: parts[1] };
}

export function sampleSessionPlan() {
  const minutes = testSessionMinutes() || config.sessionMinutes;
  return {
    sessionMs: randomInt(minutes.min * 60_000, minutes.max * 60_000),
    likeRate: randomFloat(config.likeRate.min, config.likeRate.max),
    likeCap: config.likeCapPerSession,
    skipFirstPosts: randomInt(8, 14),
    warmupMs: randomInt(70_000, 110_000),
    windDownMs: randomInt(35_000, 55_000),
    minMsBetweenLikes: randomInt(95_000, 190_000),
    settleMs: randomInt(3500, 9000),
    glanceNotifications: Math.random() < 0.32,
    reverseScrollChance: 0.05,
    expandRate: randomFloat(0.30, 0.40),
    idleChance: randomFloat(0.05, 0.12),
    followCap: sampleFollowCap(),
    followRecommended: Math.random() >= config.follow.recommendedSkipChance,
    minMsBetweenFollows: randomInt(120_000, 300_000),
    ...sampleFlow(),
  };
}
