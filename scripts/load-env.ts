/**
 * Load the same env files Next loads, in the same order.
 *
 * Bare `dotenv/config` reads only `.env`, so a script would quietly disagree
 * with the running app about APP_URL or DATABASE_URL — and print approval
 * links pointing at the wrong port.
 */
import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });
