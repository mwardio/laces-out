import { startWeeklyProjectionProcess } from "./first-party-projection-process-runtime.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("Weekly projection worker requires DATABASE_URL");
startWeeklyProjectionProcess({ connectionString });
