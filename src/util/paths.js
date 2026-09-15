import { fileURLToPath } from "node:url";

export const dataDir = process.env.WARMUP_DATA_DIR || fileURLToPath(new URL("../../data/", import.meta.url));
