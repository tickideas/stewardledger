import { createDb } from "@stewardledger/db/client";
import { env } from "./env";

export const db = createDb(env.DATABASE_URL);
