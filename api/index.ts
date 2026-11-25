import { createVercelApp } from "../server/vercel.ts";

export default createVercelApp(process.env).entry;
