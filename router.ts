import { createRouter, publicQuery } from "./middleware";
import { roomRouter } from "./room";

export const appRouter = createRouter({
  ping: publicQuery.query(() => ({ ok: true, ts: Date.now() })),
  room: roomRouter,
});

export type AppRouter = typeof appRouter;
