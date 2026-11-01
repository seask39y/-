import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "./middleware";
import { store } from "./store";

const nicknameSchema = z
  .string()
  .trim()
  .min(1, "请输入昵称")
  .max(12, "昵称最多 12 个字符");

const codeSchema = z.string().regex(/^\d{6}$/, "房间号是 6 位数字");

export const roomRouter = createRouter({
  create: publicQuery
    .input(z.object({ nickname: nicknameSchema }))
    .mutation(async ({ input }) => {
      return store.create(input.nickname);
    }),

  join: publicQuery
    .input(z.object({ code: codeSchema, nickname: nicknameSchema }))
    .mutation(async ({ input }) => {
      const result = await store.join(input.code, input.nickname);
      if (!result) {
        throw new TRPCError({ code: "NOT_FOUND", message: "房间不存在或已被焚毁" });
      }
      return result;
    }),

  state: publicQuery
    .input(
      z.object({
        code: codeSchema,
        token: z.string().min(1),
        sinceId: z.number().int().min(0).default(0),
      }),
    )
    .query(async ({ input }) => {
      const r = await store.state(input.code, input.token, input.sinceId);
      if (r.status === "gone") {
        throw new TRPCError({ code: "NOT_FOUND", message: "房间不存在或已被焚毁" });
      }
      if (r.status === "closed") {
        return { closed: true as const, code: r.code };
      }
      return {
        closed: false as const,
        code: r.code,
        me: r.me,
        members: r.members,
        messages: r.messages,
        latestId: r.latestId,
      };
    }),

  send: publicQuery
    .input(
      z.object({
        code: codeSchema,
        token: z.string().min(1),
        text: z.string().trim().min(1, "消息不能为空").max(500, "单条消息最多 500 字"),
      }),
    )
    .mutation(async ({ input }) => {
      const r = await store.send(input.code, input.token, input.text);
      if (r === "gone" || r === "closed") {
        throw new TRPCError({ code: "NOT_FOUND", message: "房间已被焚毁" });
      }
      if (r === "not_member") {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "你不在此房间中" });
      }
      return { ok: true as const };
    }),

  leave: publicQuery
    .input(z.object({ code: codeSchema, token: z.string().min(1) }))
    .mutation(async ({ input }) => {
      await store.leave(input.code, input.token);
      return { ok: true as const };
    }),

  burn: publicQuery
    .input(z.object({ code: codeSchema, token: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const r = await store.burn(input.code, input.token);
      if (r === "gone") {
        throw new TRPCError({ code: "NOT_FOUND", message: "房间不存在或已被焚毁" });
      }
      if (r === "not_member" || r === "forbidden") {
        throw new TRPCError({ code: "FORBIDDEN", message: "只有房主可以焚毁房间" });
      }
      return { ok: true as const };
    }),
});
